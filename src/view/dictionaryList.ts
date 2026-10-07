/** Shared machinery for the views that list every dictionary in the vault. */

import type { App, TFile } from "obsidian";
import { dictionaryConfig } from "../obsidian/dictionaryFile";
import { statsForFile, type Stats } from "../render/statsView";

/**
 * How long a vault-wide view waits before redrawing. Long, because these views
 * re-read every dictionary in the vault: a review session or a burst of edits
 * should cost one pass, not one per write.
 */
export const REDRAW_DELAY = 400;

/** Shared so the two views cannot drift into wording it differently. */
export const NO_DICTIONARIES =
  "No dictionaries yet. Give a note a fsrs-vocabulary property to start one.";

export interface DictionaryRow {
  file: TFile;
  stats: Stats;
  muted: boolean;
}

/**
 * Read every dictionary's numbers. Notes that turn out not to be dictionaries are
 * dropped, so the caller's list can lag the vault without showing empty rows.
 */
export async function collectRows(app: App, files: TFile[], now: Date): Promise<DictionaryRow[]> {
  const rows: DictionaryRow[] = [];
  for (const file of files) {
    const stats = await statsForFile(app, file, now);
    if (!stats) continue;
    rows.push({ file, stats, muted: dictionaryConfig(app, file).mute });
  }
  return rows;
}
