import { readFileSync } from "node:fs";
import {
  dateDiffInDays,
  default_w,
  forgetting_curve,
  fsrs,
  generatorParameters,
  State,
  type FSRSState,
} from "ts-fsrs";
import { describe, expect, it, vi } from "vitest";
import type { ReviewLogEntry } from "../src/model/history";
import { gradeOf, newCard, review, type ReviewRating } from "../src/model/srs";
import type { FsrsEngine } from "../src/optimizer/engine";
import { alignWithScheduler, fitWeights, logLoss } from "../src/optimizer/fit";
import { buildItems, type TrainingItem } from "../src/optimizer/items";

// fsrs-browser's loader brings a thread-pool helper that listens for messages on
// `self` as soon as it is imported; under node there is no `self` to listen on.
vi.stubGlobal("self", { addEventListener: () => undefined, removeEventListener: () => undefined });
const { loadEngine } = await import("../src/optimizer/engine");
const wasm = new URL("../node_modules/fsrs-browser/fsrs_browser_bg.wasm", import.meta.url);
const engine = loadEngine(new Uint8Array(readFileSync(wasm)));

/** A small deterministic generator, so a synthetic history is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 9);

/**
 * The review log of a learner whose memory follows `truth`, scheduled the way the
 * plugin schedules before any fit: with the default weights. Recall at each review is
 * drawn from what `truth` predicts for that card at that moment.
 */
function simulate(truth: readonly number[], seed: number, cards = 300, days = 240): ReviewLogEntry[] {
  const rnd = random(seed);
  const model = fsrs(generatorParameters({ w: [...truth] }));
  const entries: ReviewLogEntry[] = [];
  const end = START + days * DAY;
  for (let c = 0; c < cards; c++) {
    let now = new Date(START + Math.floor(rnd() * (days / 2)) * DAY);
    let card = newCard(now);
    let memory: FSRSState | null = null;
    let last: Date | null = null;
    while (now.getTime() < end) {
      const elapsed = last ? dateDiffInDays(last, now) : 0;
      const recall =
        memory === null ? 0.7 : elapsed === 0 ? 0.95 : forgetting_curve([...truth], elapsed, memory.stability);
      const remembered = rnd() < recall;
      const roll = rnd();
      const rating: ReviewRating = !remembered ? "again" : roll < 0.1 ? "hard" : roll < 0.9 ? "good" : "easy";
      entries.push({ c: `c${c.toString()}`, t: now.getTime(), r: gradeOf(rating), s: card.state });
      memory = model.next_state(memory, elapsed, gradeOf(rating));
      card = review(card, rating, { retention: 0.9, weights: null }, now);
      last = now;
      now = card.due;
    }
  }
  return entries;
}

/** A learner who forgets new material much faster than the defaults assume. */
const FORGETFUL = default_w.map((w, i) => (i < 4 ? w * 0.25 : i === 8 ? w * 0.7 : w));

describe("the optimizer and the scheduler share one model", () => {
  it("start from the same default weights", () => {
    const defaults = engine.defaultWeights();
    expect(defaults).toHaveLength(default_w.length);
    defaults.forEach((w, i) => {
      expect(w).toBeCloseTo(default_w[i] ?? Number.NaN, 4);
    });
  });

  it("agree on the memory a history leaves behind, for weights the fit can adopt", () => {
    // fsrs-rs computes it for the fit, ts-fsrs for every schedule; if they
    // disagreed, weights fitted by one would be wrong for the other. FORGETFUL has
    // initial stabilities below the scheduler's floor, which is where they part.
    const weights = alignWithScheduler(FORGETFUL);
    const items = buildItems(simulate(FORGETFUL, 7, 40)).slice(0, 200);
    expect(items.length).toBeGreaterThan(100);
    const fromOptimizer = engine.stabilities(weights, items);
    const scheduler = fsrs(generatorParameters({ w: weights }));
    items.forEach((item, index) => {
      let memory: FSRSState | null = null;
      for (const step of item.reviews.slice(0, -1)) {
        memory = scheduler.next_state(memory, step.deltaT, step.rating);
      }
      const expected = memory?.stability ?? Number.NaN;
      const actual = fromOptimizer[index] ?? Number.NaN;
      expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-3);
    });
  });
});

describe("fitWeights on a real history", () => {
  const history = simulate(FORGETFUL, 1);

  it("adopts weights that predict the learner better than the defaults", () => {
    const outcome = fitWeights(engine, history, null);
    expect(outcome.status).toBe("adopted");
    if (outcome.status !== "adopted" || !outcome.weights) return;
    expect(outcome.lossAfter).toBeLessThan(outcome.lossBefore);
    expect(outcome.weights).toHaveLength(default_w.length);
    // Judged on reviews from a different run of the same learner, which neither the
    // fit nor the decision saw.
    const fresh = buildItems(simulate(FORGETFUL, 2));
    expect(logLoss(engine, outcome.weights, fresh)).toBeLessThan(logLoss(engine, default_w, fresh));
  });

  it("does not fit a history that is still too short", () => {
    const short = history.filter((entry) => Number(entry.c.slice(1)) < 20);
    expect(fitWeights(engine, short, null)).toEqual({
      status: "not-enough",
      items: buildItems(short).length,
    });
  });
});

/**
 * An engine whose model is one number: the stability of every memory is the first
 * weight. Enough to steer the decision without the real optimizer in the way.
 */
function fakeEngine(fits: number[][]): FsrsEngine & { trained: TrainingItem[][] } {
  const trained: TrainingItem[][] = [];
  return {
    trained,
    defaultWeights: () => [...default_w],
    train(items) {
      trained.push([...items]);
      return fits[trained.length - 1] ?? [...default_w];
    },
    stabilities: (weights, items) => items.map(() => weights[0] ?? 1),
  };
}

/** Weights that differ from the defaults in their first value only. */
const withFirst = (w0: number): number[] => default_w.map((w, i) => (i === 0 ? w0 : w));

/** A card answered on days 0 and 1, every time remembered: longer stability predicts it better. */
function remembered(count: number): ReviewLogEntry[] {
  const entries: ReviewLogEntry[] = [];
  for (let c = 0; c < count; c++) {
    entries.push({ c: `c${c.toString()}`, t: START + c * 1000, r: 3, s: State.New });
    entries.push({ c: `c${c.toString()}`, t: START + DAY + c * 1000, r: 3, s: State.Review });
  }
  return entries;
}

describe("fitWeights decides", () => {
  it("trains the candidate on the older reviews and judges it on the newest", () => {
    const engine = fakeEngine([withFirst(50), withFirst(50)]);
    fitWeights(engine, remembered(100), null, 10);
    const all = buildItems(remembered(100));
    expect(engine.trained[0]).toEqual(all.slice(0, 80));
  });

  it("keeps the weights in use when the candidate predicts worse", () => {
    const engine = fakeEngine([withFirst(0.01)]);
    const outcome = fitWeights(engine, remembered(100), null, 10);
    expect(outcome).toMatchObject({ status: "kept", weights: null });
    expect(engine.trained).toHaveLength(1);
  });

  it("adopts the fit over every review when the candidate predicts better", () => {
    const engine = fakeEngine([withFirst(50), withFirst(60)]);
    const outcome = fitWeights(engine, remembered(100), null, 10);
    expect(outcome).toMatchObject({ status: "adopted", weights: withFirst(60) });
    expect(engine.trained[1]).toHaveLength(100);
  });

  it("compares against the weights in use, not the defaults", () => {
    // Both fits would beat the defaults; neither beats the weights in use.
    const engine = fakeEngine([withFirst(50), withFirst(50)]);
    expect(fitWeights(engine, remembered(100), withFirst(80), 10).status).toBe("kept");
    expect(fitWeights(fakeEngine([withFirst(50), withFirst(50)]), remembered(100), null, 10).status).toBe(
      "adopted",
    );
  });

  it("keeps the weights in use when the full fit does worse than them", () => {
    const engine = fakeEngine([withFirst(50), withFirst(0.01)]);
    expect(fitWeights(engine, remembered(100), null, 10).status).toBe("kept");
  });

  it("adopts weights in the form the scheduler runs them", () => {
    // Remembering nothing makes the shortest first stability the best fit, and the
    // scheduler will not start a card below its floor.
    const forgotten = remembered(100).map((entry) => (entry.s === State.Review ? { ...entry, r: 1 as const } : entry));
    const engine = fakeEngine([withFirst(0.01), withFirst(0.01)]);
    const outcome = fitWeights(engine, forgotten, null, 10);
    expect(outcome).toMatchObject({ status: "adopted", weights: alignWithScheduler(withFirst(0.01)) });
    expect(outcome.status === "adopted" && outcome.weights?.[0]).toBeGreaterThanOrEqual(0.1);
  });

  it("never adopts weights the scheduler could not use", () => {
    const engine = fakeEngine([withFirst(50), [...withFirst(60), 1]]);
    expect(fitWeights(engine, remembered(100), null, 10).status).toBe("kept");
  });
});
