# Vendored: Transformers.js runtime

These three files run the on-device AI. They are served from this app's own origin, so enabling
AI never contacts a CDN: the only third-party request is the model download from Hugging Face.

| File | Size | sha256 |
| --- | --- | --- |
| `transformers.min.js` | 888,173 B | `aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa` |
| `ort-wasm-simd-threaded.jsep.mjs` | 44,484 B | `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9` |
| `ort-wasm-simd-threaded.jsep.wasm` | 21,596,019 B | `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39` |

- **Source:** `@huggingface/transformers@3.8.1` from the npm registry (`dist/`). The tarball's
  integrity was checked against the registry before copying:
  `sha512-tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA==`
- **Licences:** Transformers.js is Apache-2.0 (`LICENSE`, here). The `.wasm` is ONNX Runtime Web,
  MIT, bundled by that package.
- **Why 3.8.1 and not 4.x:** the 4.x web bundle has bare imports (`from "onnxruntime-web/webgpu"`)
  that a no-build static site can't resolve, and it pins a nightly ONNX Runtime. 3.8.1 is one
  self-contained file plus the WebAssembly binary.
- **Why `transformers.min.js` and not `transformers.web.min.js`:** the `.web` build also imports
  `onnxruntime-web` by bare name.

## Updating

```sh
npm pack @huggingface/transformers@<version>        # then compare the tarball's integrity to
npm view @huggingface/transformers@<version> dist.integrity   # the registry's before trusting it
tar xzf huggingface-transformers-<version>.tgz
cp package/dist/transformers.min.js package/dist/ort-wasm-simd-threaded.jsep.{mjs,wasm} vendor/transformers/
sha256sum vendor/transformers/*                     # and update the table above
```

Then re-run the browser checks: a new version can rename its files or change how the WebAssembly
is located (`env.backends.onnx.wasm.wasmPaths` in `js/ai-worker.js`), and its default is a CDN.
