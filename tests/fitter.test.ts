import { State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import type { ReviewLogEntry } from "../src/model/history";
import type { FitOutcome } from "../src/optimizer/fit";
import { WeightFitter, type FitterDeps } from "../src/optimizer/fitter";
import { buildItems } from "../src/optimizer/items";
import type { FitRecord } from "../src/settings";

const DAY = 24 * 60 * 60 * 1000;

/** `count` cards answered on two days each: one training item per card. */
function history(count: number): ReviewLogEntry[] {
  const entries: ReviewLogEntry[] = [];
  for (let c = 0; c < count; c++) {
    entries.push({ c: `c${c.toString()}`, t: c, r: 3, s: State.New });
    entries.push({ c: `c${c.toString()}`, t: DAY + c, r: 3, s: State.Review });
  }
  return entries;
}

const NEW_WEIGHTS = Array.from({ length: 21 }, () => 1);

interface Harness {
  fitter: WeightFitter;
  deps: FitterDeps;
  state: { weights: number[] | null; fit: FitRecord | null };
  fits: number;
  setHistory: (entries: ReviewLogEntry[]) => void;
}

function harness(
  outcome: (items: number) => FitOutcome = (items) => ({
    status: "adopted",
    items,
    lossBefore: 0.5,
    lossAfter: 0.4,
    weights: NEW_WEIGHTS,
  }),
): Harness {
  let entries: ReviewLogEntry[] = [];
  const h: Harness = {
    state: { weights: null, fit: null },
    fits: 0,
    setHistory: (next) => {
      entries = next;
    },
  } as Harness;
  h.deps = {
    readHistory: () => Promise.resolve(entries),
    runFit: (request) => {
      h.fits += 1;
      return Promise.resolve(outcome(buildItems(request.entries).length));
    },
    current: () => h.state,
    save: (weights, fit) => {
      h.state = { weights, fit };
      return Promise.resolve();
    },
    now: () => 12345,
  };
  h.fitter = new WeightFitter(h.deps, 400);
  return h;
}

describe("WeightFitter", () => {
  it("waits for enough reviews before the first automatic fit", async () => {
    const h = harness();
    h.setHistory(history(399));
    expect(await h.fitter.fitIfDue()).toBeNull();
    expect(h.fits).toBe(0);
    h.setHistory(history(400));
    expect(await h.fitter.fitIfDue()).toMatchObject({ status: "adopted" });
    expect(h.fits).toBe(1);
  });

  it("adopts new weights and records the fit", async () => {
    const h = harness();
    h.setHistory(history(400));
    await h.fitter.fitIfDue();
    expect(h.state).toEqual({
      weights: NEW_WEIGHTS,
      fit: { at: 12345, items: 400, status: "adopted", lossBefore: 0.5, lossAfter: 0.4 },
    });
  });

  it("records a kept fit without touching the weights in use", async () => {
    const h = harness((items) => ({ status: "kept", items, lossBefore: 0.4, lossAfter: 0.5, weights: null }));
    h.state.weights = [...NEW_WEIGHTS];
    h.setHistory(history(400));
    await h.fitter.fitIfDue();
    expect(h.state.weights).toEqual(NEW_WEIGHTS);
    expect(h.state.fit).toMatchObject({ status: "kept", items: 400 });
  });

  it("fits again automatically only once as many new reviews have come in", async () => {
    const h = harness();
    h.setHistory(history(400));
    await h.fitter.fitIfDue();
    h.setHistory(history(799));
    expect(await h.fitter.fitIfDue()).toBeNull();
    h.setHistory(history(800));
    expect(await h.fitter.fitIfDue()).not.toBeNull();
    expect(h.fits).toBe(2);
  });

  it("fits on request whenever there is enough history, due or not", async () => {
    const h = harness();
    h.setHistory(history(400));
    await h.fitter.fitIfDue();
    await h.fitter.fitNow();
    expect(h.fits).toBe(2);
  });

  it("says there is not enough history instead of fitting", async () => {
    const h = harness();
    h.setHistory(history(10));
    expect(await h.fitter.fitNow()).toEqual({ status: "not-enough", items: 10 });
    expect(h.fits).toBe(0);
    expect(h.state.fit).toBeNull();
  });

  it("runs one fit at a time", async () => {
    const h = harness();
    h.setHistory(history(400));
    const [a, b] = await Promise.all([h.fitter.fitNow(), h.fitter.fitNow()]);
    expect(h.fits).toBe(1);
    expect(a).toBe(b);
  });

  it("does not retry a failing automatic fit on every check", async () => {
    const h = harness(() => {
      throw new Error("no worker");
    });
    h.setHistory(history(400));
    await expect(h.fitter.fitIfDue()).rejects.toThrow("no worker");
    expect(await h.fitter.fitIfDue()).toBeNull();
    expect(h.fits).toBe(1);
  });

  it("counts what the settings tab shows", async () => {
    const h = harness();
    h.setHistory([...history(5), { c: "late", t: 0, r: 3, s: State.Review }]);
    expect(await h.fitter.counts()).toEqual({ reviews: 11, items: 5 });
  });
});
