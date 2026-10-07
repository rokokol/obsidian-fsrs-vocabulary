/**
 * The fit, run in a Web Worker so a long one does not freeze Obsidian.
 *
 * This file is bundled on its own, with fsrs-browser's module inlined as bytes, and
 * the result is inlined into the plugin as the worker's source text: the plugin ships
 * as a single script, so the worker cannot be a file of its own. Each fit gets a
 * fresh worker, which also means a fresh module — a fit that fails inside the module
 * cannot leave it broken for the next one.
 */

import wasm from "fsrs-browser/fsrs_browser_bg.wasm";
import { loadEngine } from "./engine";
import { fitWeights } from "./fit";
import type { FitReply, FitRequest } from "./protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FitRequest>) => void) | null;
  postMessage: (reply: FitReply) => void;
};

scope.onmessage = (event) => {
  const { entries, current } = event.data;
  try {
    scope.postMessage({ ok: true, outcome: fitWeights(loadEngine(wasm), entries, current) });
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
