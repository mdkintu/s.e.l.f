// ai-worker.js — runs the on-device model in a Web Worker, so the interface never freezes.
//
// Everything that touches the network for AI happens in THIS file, and only here:
//
//   • The Transformers.js runtime and its WebAssembly binary are served from this app's own
//     origin (../vendor/transformers/), never from a CDN.
//   • The model is fetched from huggingface.co, once, and only when the person has said yes.
//   • The fetch guard below refuses every other request, and refuses ALL non-local requests
//     unless a download was explicitly allowed. Belt and braces: hosting adds a matching
//     Content-Security-Policy header for this file (see _headers / vercel.json).
//
// It receives the facts as chat messages, returns text, and keeps nothing.
// Messages in:  { type: 'load', id, model, download } | { type: 'write', id, messages, maxNewTokens } | { type: 'interrupt' }
// Messages out: progress · phase · tokens · loaded · result · interrupted · error

/* ------------------------------------------------------------------ */
/* Network guard                                                       */
/* ------------------------------------------------------------------ */

// The only third-party hosts this file will ever talk to: the Hugging Face model host and the
// CDN it redirects to. Keep in step with connect-src in _headers and vercel.json.
const MODEL_HOSTS = /(^|\.)(huggingface\.co|hf\.co)$/;

let downloadAllowed = false;
let blocked = false; // set when the guard refused something, so "not downloaded yet" can be told apart from a real failure

const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, self.location.href);
  if (url.origin !== self.location.origin) {
    const allowed = downloadAllowed && url.protocol === 'https:' && MODEL_HOSTS.test(url.hostname);
    if (!allowed) {
      blocked = true;
      return Promise.reject(new TypeError(`Blocked a request to ${url.hostname}`));
    }
  }
  return nativeFetch(input, init);
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let tf = null;          // the Transformers.js module, loaded on first use
let generator = null;   // the text-generation pipeline
let device = null;      // 'webgpu' | 'wasm'
let modelSpec = null;
let stopping = null;

const post = (message) => self.postMessage(message);

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function loadRuntime() {
  if (tf) return tf;
  tf = await import('../vendor/transformers/transformers.min.js');
  const { env } = tf;
  env.allowLocalModels = false;
  env.allowRemoteModels = true; // the fetch guard above is what decides whether a request may leave
  env.useBrowserCache = true;   // downloaded files are kept in the browser's Cache API
  // Without this the library falls back to a CDN for its WebAssembly binary.
  env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
  // Multi-threading needs cross-origin isolation, which static hosting doesn't give us for free.
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 1) : 1;
  return tf;
}

async function pickDevice() {
  try {
    if (self.navigator?.gpu && await self.navigator.gpu.requestAdapter()) return 'webgpu';
  } catch { /* no usable GPU: fall through */ }
  return 'wasm';
}

/** Byte progress across every file, throttled so a fast download doesn't flood the main thread. */
function makeProgress() {
  const files = new Map();
  let last = 0;
  return (event) => {
    if (event.status === 'progress' && event.file) {
      files.set(event.file, { loaded: event.loaded ?? 0, total: event.total ?? 0 });
    }
    if (event.status === 'done' && event.file?.endsWith('.onnx')) post({ type: 'phase', phase: 'loading' });
    const now = Date.now();
    if (now - last < 120 && event.status !== 'done') return;
    last = now;
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    post({ type: 'progress', loaded, total });
  };
}

async function build(which, progress) {
  return tf.pipeline('text-generation', modelSpec.id, {
    device: which,
    dtype: modelSpec.dtype,
    revision: modelSpec.revision,
    progress_callback: progress,
  });
}

async function load({ id, model, download }) {
  modelSpec = model;
  downloadAllowed = download === true;
  blocked = false;
  try {
    await loadRuntime();
    if (generator) { post({ type: 'loaded', id, device }); return; }
    const progress = makeProgress();
    device = await pickDevice();
    try {
      generator = await build(device, progress);
    } catch (err) {
      // A GPU that reports itself but can't run the model: use the CPU instead. The files are
      // already in the cache by now, so this costs no second download.
      if (device !== 'webgpu' || blocked) throw err;
      device = 'wasm';
      generator = await build(device, progress);
    }
    post({ type: 'loaded', id, device });
  } catch (err) {
    generator = null;
    post(blocked
      ? { type: 'error', id, code: 'not-cached', message: 'The AI model is not on this device yet. Enable AI insights to download it.' }
      : { type: 'error', id, code: 'failed', message: `The AI model could not be loaded: ${err?.message ?? err}` });
  } finally {
    downloadAllowed = false; // a download is permitted for the length of one load(), and no longer
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

function textOf(output) {
  const first = output?.[0]?.generated_text;
  return Array.isArray(first) ? first.at(-1)?.content ?? '' : first ?? '';
}

async function run(messages, maxNewTokens) {
  stopping = new tf.InterruptableStoppingCriteria();
  let n = 0;
  let last = 0;
  const streamer = new tf.TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: () => {},
    token_callback_function: () => {
      n += 1;
      const now = Date.now();
      if (now - last > 250) { last = now; post({ type: 'tokens', n }); }
    },
  });
  const output = await generator(messages, {
    max_new_tokens: maxNewTokens,
    do_sample: false, // greedy: the same facts give the same text, and there is no randomness to blame
    return_full_text: false,
    streamer,
    stopping_criteria: stopping,
  });
  return { text: textOf(output), interrupted: stopping.interrupted === true };
}

async function write({ id, messages, maxNewTokens }) {
  if (!generator) { post({ type: 'error', id, code: 'failed', message: 'The AI model is not loaded.' }); return; }
  try {
    let result;
    try {
      result = await run(messages, maxNewTokens);
    } catch (err) {
      // The GPU can be lost part-way through (driver reset, tab throttled). Rebuild on the CPU once.
      if (device !== 'webgpu') throw err;
      device = 'wasm';
      generator = await build(device, () => {});
      result = await run(messages, maxNewTokens);
    }
    if (result.interrupted) post({ type: 'interrupted', id });
    else post({ type: 'result', id, text: result.text });
  } catch (err) {
    // Deliberately not echoing the messages: they hold the person's figures.
    post({ type: 'error', id, code: 'failed', message: `The summary could not be written: ${err?.message ?? err}` });
  } finally {
    stopping = null;
  }
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'load') load(msg);
  else if (msg.type === 'write') write(msg);
  else if (msg.type === 'interrupt') stopping?.interrupt();
};
