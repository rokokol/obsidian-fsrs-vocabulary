/** Module shapes the build gives files it loads itself; see esbuild.config.mjs. */

/** A WebAssembly module, inlined as its bytes. */
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}

/** A module bundled on its own and inlined as source text, to start a Web Worker from. */
declare module "inline-worker:*" {
  const source: string;
  export default source;
}
