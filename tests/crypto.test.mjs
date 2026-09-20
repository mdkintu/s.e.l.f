// Step 2 tests: encryption at rest. No dependencies: run with `node --test tests/`.
//
// These check the security properties themselves, not just that the code runs: that nothing
// readable reaches storage, that the advertised KDF parameters are the ones actually used,
// that the key cannot be extracted, and that no failure path can lose data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'], language: 'en-US' }, configurable: true });

const vault = await import('../js/crypto.js');
const store = await import('../js/store.js');

const PASS = 'correct horse battery staple';
const VAULT_KEY = 'self.vault';
const PLAIN_KEY = 'self.data';

// Distinctive enough that a chance match inside base64 is not a realistic worry.
const NOTE = 'Zanzibar cardamom from Kariakoo';
const AMOUNT = 987654321;

const dump = () => JSON.stringify([...localStorage.map.entries()]);
const readVault = () => JSON.parse(localStorage.getItem(VAULT_KEY));

const mainOf = (name) => store.getCategories().find((m) => m.name === name);
const subOf = (main, name) => mainOf(main).subs.find((s) => s.name === name);

function seed({ amount = AMOUNT, note = NOTE } = {}) {
  const main = mainOf('Food');
  return store.addTransaction({
    type: 'expense', amount, categoryId: main.id, subCategoryId: subOf('Food', 'Groceries').id,
    date: '2026-09-15', note,
  });
}

/** A device with Step 1 plaintext data on it. */
function plainDevice() {
  localStorage.clear();
  store.init();
  seed();
  return store.getState();
}

/* ---------------------------------------------------------------- crypto.js */

test('the derived key is non-extractable: the raw bytes cannot be read back out', async () => {
  const key = await vault.deriveKey(PASS, vault.newSalt());
  assert.equal(key.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey('raw', key), /extractable|export/i);
  await assert.rejects(() => crypto.subtle.exportKey('jwk', key), /extractable|export/i);
});

test('every seal uses a fresh random IV, and salts differ between vaults', async () => {
  const key = await vault.deriveKey(PASS, vault.newSalt());
  const a = await vault.seal(key, { hello: 'world' });
  const b = await vault.seal(key, { hello: 'world' });
  assert.notEqual(a.iv, b.iv, 'a repeated save must not repeat its IV');
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(vault.fromBase64(a.iv).length, 12);
  assert.equal(vault.newSalt().length, 16);
  assert.notEqual(vault.toBase64(vault.newSalt()), vault.toBase64(vault.newSalt()));
});

test('a tampered ciphertext is rejected, never returned as plausible data', async () => {
  const key = await vault.deriveKey(PASS, vault.newSalt());
  const { iv, ciphertext } = await vault.seal(key, { amount: 5 });
  const bytes = vault.fromBase64(ciphertext);
  bytes[0] ^= 0x01;
  await assert.rejects(() => vault.open(key, iv, vault.toBase64(bytes)), vault.CryptoError);
});

test('the check value tells a wrong key from a right one', async () => {
  const salt = vault.newSalt();
  const right = await vault.deriveKey(PASS, salt);
  const wrong = await vault.deriveKey('something else entirely', salt);
  const check = await vault.makeCheck(right);
  assert.equal(await vault.checkKey(right, check), true);
  assert.equal(await vault.checkKey(wrong, check), false);
  assert.equal(await vault.checkKey(right, null), false, 'a missing check must not pass');
});

test('the strength meter ranks passphrases sensibly and never accepts a short one', () => {
  const score = (p) => vault.passphraseStrength(p).score;
  assert.equal(score('abc'), 0, 'under the minimum');
  assert.equal(vault.passphraseStrength('abc').label, 'Too short');
  assert.ok(score('password') <= 1, 'a common word is weak');
  assert.ok(score('11111111') <= 1, 'digits only is weak');
  assert.ok(score('abcdefgh') <= 1, 'a straight sequence is weak');
  assert.ok(score(PASS) >= 3, 'four unrelated words should rate well');
  assert.ok(score('Tr0ub4dor&3xplosion!') >= 3);
  assert.ok(score('aaaaaaaaaaaaaaaaaaaa') < score('correct horse battery'), 'repetition is not length');
});

/** Source with comments removed, so these scans test the code and not the prose about it. */
const codeOf = (file) => readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('no module uses Math.random for anything', () => {
  for (const file of ['crypto.js', 'store.js', 'schema.js', 'app.js']) {
    assert.equal(/Math\s*\.\s*random/.test(codeOf(file)), false, `${file} must not use Math.random`);
  }
});

test('no module logs to the console', () => {
  for (const file of ['crypto.js', 'store.js', 'app.js']) {
    assert.equal(/console\s*\.\s*(log|debug|info|warn|error|trace|dir)/.test(codeOf(file)), false, `${file} must not log`);
  }
});

/* ---------------------------------------------------------------- at rest */

test('localStorage holds no readable amounts, categories or notes', async () => {
  plainDevice();
  assert.ok(dump().includes(NOTE), 'control: the note IS readable before encryption');

  await store.setupEncryption(PASS);
  await store.flush();

  const raw = dump();
  for (const secret of [NOTE, String(AMOUNT), 'Groceries', 'exp.food', 'Housing', 'UGX', 'transactions', 'categoryId']) {
    assert.equal(raw.includes(secret), false, `"${secret}" must not be readable in storage`);
  }
  assert.equal(raw.includes(PASS), false, 'the passphrase must never be stored');

  // Only the sealed envelope is left, and every field of it is opaque base64.
  const envelope = readVault();
  assert.deepEqual(Object.keys(envelope).sort(), ['check', 'ciphertext', 'iv', 'salt', 'schemaVersion']);
  assert.equal(envelope.schemaVersion, 1);
  for (const field of [envelope.salt, envelope.iv, envelope.ciphertext, envelope.check.iv, envelope.check.ciphertext]) {
    assert.match(field, /^[A-Za-z0-9+/]+={0,2}$/);
  }
  assert.equal(localStorage.getItem(PLAIN_KEY), null, 'the plaintext copy is gone');
});

test('the stored vault really is PBKDF2-SHA256 at 600,000 iterations and AES-GCM-256', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();
  const envelope = readVault();

  // Rebuild the key from the published parameters, independently of the app's own code.
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: vault.fromBase64(envelope.salt), iterations: 600_000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: vault.fromBase64(envelope.iv) }, key, vault.fromBase64(envelope.ciphertext),
  );
  const doc = JSON.parse(new TextDecoder().decode(plaintext));
  assert.equal(doc.transactions[0].note, NOTE, 'those exact parameters open the vault');

  // One iteration fewer must not.
  const weak = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: vault.fromBase64(envelope.salt), iterations: 599_999, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  await assert.rejects(() => crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: vault.fromBase64(envelope.iv) }, weak, vault.fromBase64(envelope.ciphertext),
  ));
});

/* ---------------------------------------------------------------- lock and unlock */

test('Step 1 data migrates into the vault without loss', async () => {
  const before = plainDevice();
  assert.ok(localStorage.getItem(PLAIN_KEY), 'starts as Step 1 plaintext');

  await store.setupEncryption(PASS);
  await store.flush();

  assert.equal(localStorage.getItem(PLAIN_KEY), null);
  assert.deepEqual(store.getState(), before, 'in memory, nothing changed');

  store.init();
  await store.unlock(PASS);
  assert.deepEqual(store.getState(), before, 'and nothing changed on the way through storage');
});

test('a refresh always relocks, and reveals nothing until the passphrase is given', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();

  const boot = store.init(); // this is what a page refresh does
  assert.equal(boot.locked, true);
  assert.equal(boot.mode, 'encrypted');
  assert.equal(store.isLocked(), true);
  assert.deepEqual(store.getTransactions(), [], 'nothing readable while locked');
  assert.equal(store.getState(), null);
  assert.throws(() => store.updateSettings({ privacyMode: true }), /locked/);

  await store.unlock(PASS);
  assert.equal(store.isLocked(), false);
  assert.equal(store.getTransactions()[0].note, NOTE);
});

test('locking forgets the ledger; unlocking brings it back intact', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  const before = store.getState();

  await store.lock();
  assert.equal(store.getState(), null);
  assert.deepEqual(store.getTransactions(), []);

  await store.unlock(PASS);
  assert.deepEqual(store.getState(), before);
});

test('a wrong passphrase fails cleanly and leaves the data untouched', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();
  const sealed = localStorage.getItem(VAULT_KEY);

  store.init();
  await assert.rejects(() => store.unlock('not the passphrase'), /Incorrect passphrase/);
  assert.equal(store.isLocked(), true, 'still locked');
  assert.equal(localStorage.getItem(VAULT_KEY), sealed, 'the vault was not rewritten');

  await store.unlock(PASS);
  assert.equal(store.getTransactions()[0].note, NOTE, 'the real passphrase still works');
});

test('a right passphrase over damaged data says so, instead of blaming the passphrase', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();

  // Corrupt the ledger but leave the check value alone: this is what disk rot looks like.
  const envelope = readVault();
  const bytes = vault.fromBase64(envelope.ciphertext);
  bytes[5] ^= 0xff;
  localStorage.setItem(VAULT_KEY, JSON.stringify({ ...envelope, ciphertext: vault.toBase64(bytes) }));

  store.init();
  await assert.rejects(() => store.unlock(PASS), /correct, but the saved data is damaged/);
  assert.equal(store.isLocked(), true);
});

test('an unreadable vault comes up locked and damaged, never as a fresh empty ledger', () => {
  localStorage.clear();
  localStorage.setItem(VAULT_KEY, '{not json');
  const boot = store.init();
  assert.equal(boot.mode, 'encrypted');
  assert.equal(boot.locked, true);
  assert.equal(boot.damaged, true);
  assert.equal(store.isVaultDamaged(), true);
  assert.deepEqual(store.getTransactions(), [], 'and it shows nothing');
});

test('wrong attempts are throttled with an increasing delay', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  store.init();

  assert.equal(store.lockoutRemaining(), 0);
  await assert.rejects(() => store.unlock('wrong one'), /Incorrect passphrase/);
  await assert.rejects(() => store.unlock('wrong two'), /Incorrect passphrase/);
  assert.equal(store.lockoutRemaining(), 0, 'the first couple of slips cost nothing');

  await assert.rejects(() => store.unlock('wrong three'), /Incorrect passphrase/);
  const first = store.lockoutRemaining();
  assert.ok(first > 0, 'now it waits');
  assert.equal(store.failedAttempts(), 3);
  await assert.rejects(() => store.unlock(PASS), /Too many attempts/, 'even the right one has to wait');

  localStorage.setItem('self.lockout', JSON.stringify({ fails: 3, until: 0 })); // let the clock run out
  await assert.rejects(() => store.unlock('wrong four'), /Incorrect passphrase/);
  assert.ok(store.lockoutRemaining() > first, 'and it waits longer each time');

  localStorage.removeItem('self.lockout');
  await store.unlock(PASS);
  assert.equal(store.failedAttempts(), 0, 'a success clears the count');
});

/* ---------------------------------------------------------------- re-keying */

test('changing the passphrase re-encrypts under a new salt; the old one stops working', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();
  const before = store.getState();
  const oldSalt = readVault().salt;

  await store.changePassphrase(PASS, 'a whole new set of words');
  await store.flush();
  assert.notEqual(readVault().salt, oldSalt, 'a new salt, not just a new key');
  assert.deepEqual(store.getState(), before, 'the ledger itself is unchanged');

  store.init();
  await assert.rejects(() => store.unlock(PASS), /Incorrect passphrase/);
  localStorage.removeItem('self.lockout');
  await store.unlock('a whole new set of words');
  assert.deepEqual(store.getState(), before);
});

test('changing the passphrase needs the current one, and a wrong guess changes nothing', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();
  const sealed = localStorage.getItem(VAULT_KEY);

  await assert.rejects(() => store.changePassphrase('not it', 'something else long'), /not your current passphrase/);
  assert.equal(localStorage.getItem(VAULT_KEY), sealed, 'the vault was left alone');
  await assert.rejects(() => store.changePassphrase(PASS, 'short'), /at least 8/);
  assert.equal(localStorage.getItem(VAULT_KEY), sealed);
  localStorage.removeItem('self.lockout');
});

test('a failure while encrypting leaves the Step 1 plaintext exactly where it was', async () => {
  const before = plainDevice();
  const plaintext = localStorage.getItem(PLAIN_KEY);
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { if (k === VAULT_KEY) throw new DOMException('full', 'QuotaExceededError'); real(k, v); };

  await assert.rejects(() => store.setupEncryption(PASS), /storage is full|blocked/);

  localStorage.setItem = real;
  assert.equal(localStorage.getItem(PLAIN_KEY), plaintext, 'the plaintext is untouched');
  assert.equal(localStorage.getItem(VAULT_KEY), null, 'and no half-written vault is left behind');
  assert.equal(store.isEncrypted(), false);
  assert.deepEqual(store.getState(), before);
});

test('setup refuses a passphrase shorter than the minimum', async () => {
  plainDevice();
  await assert.rejects(() => store.setupEncryption('short'), /at least 8/);
  assert.equal(store.isEncrypted(), false);
  assert.equal(localStorage.getItem(VAULT_KEY), null);
});

/* ---------------------------------------------------------------- backups */

test('an encrypted backup restores on a different browser', async () => {
  // Browser A: an encrypted ledger with a few entries.
  localStorage.clear();
  store.init();
  seed();
  seed({ amount: 4200, note: 'Boda to work' });
  await store.setupEncryption(PASS);
  await store.flush();
  const original = store.getTransactions();
  const file = await store.exportEncryptedBackup();

  // The file gives nothing away either.
  assert.equal(file.includes(NOTE), false);
  assert.equal(file.includes('Boda to work'), false);
  assert.equal(vault.isEnvelope(JSON.parse(file)), true);
  assert.equal(store.looksEncrypted(file), true);

  // Browser B: a different machine, nothing on it.
  globalThis.localStorage = new MemoryStorage();
  store.init();
  assert.equal(store.isEncrypted(), false);
  assert.deepEqual(store.getTransactions(), []);

  await assert.rejects(() => store.parseEncryptedBackup(file, 'the wrong passphrase'), /Incorrect passphrase for this backup/);

  const parsed = await store.parseEncryptedBackup(file, PASS);
  assert.equal(store.previewImport(parsed).found, 2);
  store.applyImport(parsed, 'replace');
  assert.deepEqual(store.getTransactions(), original, 'every record came across intact');

  // And browser B can protect it with a passphrase of its own choosing.
  await store.setupEncryption('a different passphrase here');
  await store.flush();
  assert.equal(dump().includes('Boda to work'), false);
  store.init();
  await store.unlock('a different passphrase here');
  assert.deepEqual(store.getTransactions(), original);
});

test('a damaged encrypted backup is refused without touching what is on the device', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  const mine = store.getTransactions();

  const file = JSON.parse(await store.exportEncryptedBackup());
  const bytes = vault.fromBase64(file.ciphertext);
  bytes[3] ^= 0xff;
  const broken = JSON.stringify({ ...file, ciphertext: vault.toBase64(bytes) });

  await assert.rejects(() => store.parseEncryptedBackup(broken, PASS), /backup file is damaged/);
  await assert.rejects(() => store.parseEncryptedBackup('{}', PASS), /not an encrypted S\.E\.L\.F vault/);
  await assert.rejects(() => store.parseEncryptedBackup('not json', PASS), /not valid JSON/);
  assert.deepEqual(store.getTransactions(), mine, 'the device kept its own data');
});

test('a plain JSON backup is still recognised, and is not mistaken for an encrypted one', async () => {
  localStorage.clear();
  store.init();
  seed();
  const plain = JSON.stringify(store.exportBackup());
  assert.equal(store.looksEncrypted(plain), false);
  assert.equal(store.parseBackup(plain).backup.transactions.length, 1);
});

test('an encrypted device keeps encrypting after an import', async () => {
  localStorage.clear();
  store.init();
  await store.setupEncryption(PASS);
  seed();
  await store.flush();
  const file = await store.exportEncryptedBackup();

  store.applyImport(await store.parseEncryptedBackup(file, PASS), 'merge');
  await store.flush();
  assert.equal(store.getTransactions().length, 1, 'merging a backup of itself changes nothing');
  assert.equal(localStorage.getItem(PLAIN_KEY), null, 'and nothing was written in the clear');
  assert.equal(dump().includes(NOTE), false);
});

/* ---------------------------------------------------------------- ongoing writes */

test('every later change is written back encrypted, with a new IV each time', async () => {
  localStorage.clear();
  store.init();
  await store.setupEncryption(PASS);
  await store.flush();
  const ivs = new Set([readVault().iv]);

  for (const amount of [1000, 2000, 3000]) {
    seed({ amount, note: `note ${amount}` });
    await store.flush();
    ivs.add(readVault().iv);
    assert.equal(dump().includes(`note ${amount}`), false, 'the new note never appears in the clear');
  }
  assert.equal(ivs.size, 4, 'a fresh IV for every save');
  assert.equal(store.getWriteError(), null);

  store.init();
  await store.unlock(PASS);
  assert.equal(store.getTransactions().length, 3, 'and all three survived the round trip');
});

test('rapid changes all land, and the last one wins', async () => {
  localStorage.clear();
  store.init();
  await store.setupEncryption(PASS);
  for (let i = 0; i < 12; i += 1) seed({ amount: 100 + i, note: `rapid ${i}` });
  await store.flush();

  store.init();
  await store.unlock(PASS);
  assert.equal(store.getTransactions().length, 12);
  assert.deepEqual(store.getTransactions().map((t) => t.note).slice(-2), ['rapid 10', 'rapid 11']);
});

test('erasing clears every trace from the device', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();

  store.eraseEverything();
  assert.equal(localStorage.getItem(VAULT_KEY), null);
  assert.equal(localStorage.getItem(PLAIN_KEY), null);
  assert.equal(dump().includes(NOTE), false);
  assert.equal(store.isEncrypted(), false);
  assert.equal(store.isLocked(), false);
  assert.deepEqual(store.getTransactions(), []);
});

test('a lock landing mid re-key never blanks the ledger', async () => {
  localStorage.clear();
  store.init();
  seed();
  await store.setupEncryption(PASS);
  await store.flush();
  const NEXT = 'the replacement set of words';

  // Auto-lock fires while changePassphrase is still checking the old passphrase.
  const rekey = store.changePassphrase(PASS, NEXT).then(() => 'changed', (e) => e.message);
  await store.lock();
  const outcome = await rekey;

  assert.equal(store.isLocked(), true, 'the lock stands');
  assert.equal(store.getState(), null, 'no ledger left in memory');

  // Whichever passphrase opens it now, the ledger itself must be whole: a re-key that races
  // a lock may be abandoned or may complete, but it may never destroy data.
  let opened = null;
  for (const candidate of [PASS, NEXT]) {
    localStorage.removeItem('self.lockout');
    try { await store.unlock(candidate); opened = candidate; break; } catch { /* try the other */ }
  }
  assert.ok(opened, `neither passphrase opens the vault (re-key said: ${outcome})`);
  assert.equal(store.getTransactions().length, 1, 'the ledger survived');
  assert.equal(store.getTransactions()[0].note, NOTE);
});
