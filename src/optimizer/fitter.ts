/**
 * When the weights are fitted, and what happens to the result.
 *
 * Automatically, a fit runs once the log holds enough training items for a first fit,
 * and after that each time as many new items have come in again. A fit can also be
 * asked for at any time. Either way only a fit that predicts better replaces the
 * weights in use (see `fitWeights`), and every fit that ran is recorded, so the
 * settings tab can say what it found.
 */

import type { ReviewLogEntry } from "../model/history";
import type { FitRecord } from "../settings";
import { MIN_ITEMS, type FitOutcome } from "./fit";
import { buildItems } from "./items";
import type { FitRequest } from "./protocol";

/** What the fitter needs from the plugin. */
export interface FitterDeps {
  /** Every logged review, from every device. */
  readHistory(): Promise<ReviewLogEntry[]>;
  /** Run the fit itself, off the interface thread. */
  runFit(request: FitRequest): Promise<FitOutcome>;
  /** The weights in use and the last fit's record. */
  current(): { weights: number[] | null; fit: FitRecord | null };
  /** Store the weights to use and the record of the fit that chose them. */
  save(weights: number[] | null, fit: FitRecord | null): Promise<void>;
  /**
   * The weights in use changed and are saved: bring the stored schedules into line.
   * Called on this device only, the one that adopted or reset them.
   */
  weightsChanged(weights: number[] | null): Promise<void>;
  now(): number;
}

/** The log, counted the two ways the settings tab shows it. */
export interface HistoryCounts {
  /** Reviews logged on every device. */
  reviews: number;
  /** Of those, the questions a fit can learn from. */
  items: number;
}

/** A NaN loss is stored as null, which is what JSON would turn it into anyway. */
const loss = (value: number): number | null => (Number.isFinite(value) ? value : null);

export class WeightFitter {
  private running: Promise<FitOutcome> | null = null;
  /**
   * Item count at which an automatic fit last failed. A fit that throws — no Worker
   * on this platform, say — would otherwise run again on every check.
   */
  private failedAt: number | null = null;

  constructor(
    private readonly deps: FitterDeps,
    private readonly minItems: number = MIN_ITEMS,
  ) {}

  async counts(): Promise<HistoryCounts> {
    const entries = await this.deps.readHistory();
    return { reviews: entries.length, items: buildItems(entries).length };
  }

  /** Fit now, whatever the record says. */
  fitNow(): Promise<FitOutcome> {
    this.running ??= this.fit().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Fit if enough new reviews have come in since the last fit; null when not. */
  async fitIfDue(): Promise<FitOutcome | null> {
    if (this.running) return null;
    const entries = await this.deps.readHistory();
    const items = buildItems(entries).length;
    const since = this.deps.current().fit?.items ?? 0;
    if (items < this.minItems || items - since < this.minItems) return null;
    if (this.failedAt === items) return null;
    try {
      return await this.fitNow();
    } catch (err) {
      this.failedAt = items;
      throw err;
    }
  }

  private async fit(): Promise<FitOutcome> {
    const entries = await this.deps.readHistory();
    // Counted here too, so a request that cannot fit costs no worker.
    const items = buildItems(entries).length;
    if (items < this.minItems) return { status: "not-enough", items };
    const { weights } = this.deps.current();
    const outcome = await this.deps.runFit({ entries, current: weights });
    if (outcome.status === "not-enough") return outcome;
    const record: FitRecord = {
      at: this.deps.now(),
      items: outcome.items,
      status: outcome.status,
      lossBefore: loss(outcome.lossBefore),
      lossAfter: loss(outcome.lossAfter),
    };
    const adopted = outcome.status === "adopted" ? outcome.weights : null;
    await this.deps.save(adopted ?? weights, record);
    if (adopted) await this.deps.weightsChanged(adopted);
    return outcome;
  }

  /**
   * Go back to the default weights. The fit record stays, so the next automatic fit
   * waits for new reviews rather than bringing the same weights straight back.
   */
  async reset(): Promise<void> {
    await this.running?.catch(() => undefined);
    await this.deps.save(null, this.deps.current().fit);
    await this.deps.weightsChanged(null);
  }
}
