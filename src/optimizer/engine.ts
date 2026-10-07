/**
 * The FSRS optimizer itself: fsrs-rs, compiled to WebAssembly by fsrs-browser, behind
 * the three calls the fit needs.
 */

import { DEFAULT_PARAMETERS, Fsrs, initSync } from "fsrs-browser";
import { default_relearning_steps } from "ts-fsrs";
import type { TrainingItem } from "./items";
import { unshareImportedMemory } from "./wasmMemory";

/** What the fit asks of the optimizer. */
export interface FsrsEngine {
  /** The optimizer's own default weights. */
  defaultWeights(): number[];
  /** Weights fitted to `items`. */
  train(items: readonly TrainingItem[]): number[];
  /**
   * The memory stability each item's history leaves behind under `weights` — that
   * is, after every review but the last, the one to be predicted.
   */
  stabilities(weights: readonly number[], items: readonly TrainingItem[]): number[];
}

/** Initial pages of the module's memory, as its own loader asks for, and the ceiling. */
const MEMORY_INITIAL = 18;
const MEMORY_MAXIMUM = 16384;

/** Flatten item reviews into the three parallel arrays fsrs-browser reads. */
function flatten(sequences: readonly (readonly { rating: number; deltaT: number }[])[]): {
  ratings: Uint32Array;
  deltaTs: Uint32Array;
  lengths: Uint32Array;
} {
  const total = sequences.reduce((sum, reviews) => sum + reviews.length, 0);
  const ratings = new Uint32Array(total);
  const deltaTs = new Uint32Array(total);
  const lengths = new Uint32Array(sequences.length);
  let at = 0;
  sequences.forEach((reviews, index) => {
    lengths[index] = reviews.length;
    for (const review of reviews) {
      ratings[at] = review.rating;
      deltaTs[at] = review.deltaT;
      at += 1;
    }
  });
  return { ratings, deltaTs, lengths };
}

/**
 * Start the optimizer from the bytes of fsrs-browser's module. The module is a
 * singleton of its loader: a second call reuses the first instance.
 */
export function loadEngine(wasm: Uint8Array): FsrsEngine {
  initSync({
    module: unshareImportedMemory(wasm),
    memory: new WebAssembly.Memory({ initial: MEMORY_INITIAL, maximum: MEMORY_MAXIMUM }),
  });
  return {
    defaultWeights: () => Array.from(DEFAULT_PARAMETERS()),

    train(items) {
      const { ratings, deltaTs, lengths } = flatten(items.map((item) => item.reviews));
      const cards = BigInt64Array.from(items.map((item) => BigInt(item.card)));
      const fsrs = new Fsrs();
      try {
        // Short-term memory on, as the scheduler has it by default, and as many
        // relearning steps as the scheduler takes, so the fit describes the
        // schedule the weights will be used with.
        const weights = fsrs.computeParameters(
          ratings,
          deltaTs,
          lengths,
          undefined,
          true,
          cards,
          default_relearning_steps.length,
        );
        return Array.from(weights);
      } finally {
        fsrs.free();
      }
    },

    stabilities(weights, items) {
      const histories = items.map((item) => item.reviews.slice(0, -1));
      const { ratings, deltaTs, lengths } = flatten(histories);
      const fsrs = new Fsrs(Float32Array.from(weights));
      try {
        const states = fsrs.memoryStateBatch(ratings, deltaTs, lengths) as unknown;
        if (!Array.isArray(states) || states.length !== items.length) {
          throw new Error("fsrs-browser returned no memory state for some items");
        }
        return states.map((state: unknown) => {
          const stability = (state as { stability?: unknown } | null)?.stability;
          if (typeof stability !== "number") throw new Error("fsrs-browser memory state has no stability");
          return stability;
        });
      } finally {
        fsrs.free();
      }
    },
  };
}
