/** The messages between the plugin and the fitting worker. */

import type { ReviewLogEntry } from "../model/history";
import type { FitOutcome } from "./fit";

/** What the worker is asked to fit. */
export interface FitRequest {
  entries: ReviewLogEntry[];
  /** The weights in use, null for the defaults. */
  current: number[] | null;
}

/** What the worker answers. */
export type FitReply = { ok: true; outcome: FitOutcome } | { ok: false; error: string };
