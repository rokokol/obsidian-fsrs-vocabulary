/**
 * Recomputing every stored schedule for the current target retention.
 *
 * Retention is applied when a card is graded, so changing the setting only affects
 * cards reviewed from then on — every `due` already in the vault was computed under
 * the old target and stays there, sometimes for months. This is the deliberate,
 * one-shot way to bring them into line, rather than doing it silently on a settings
 * change: it rewrites the `srs` and `due` cells of every dictionary, which is the
 * user's own file and their own decision.
 */

import type { App, TFile } from "obsidian";
import type { Card } from "ts-fsrs";
import { SRS_COLUMN, DUE_COLUMN } from "../model/dictionary";
import {
  cardIdFromCell,
  decodeCard,
  dueDateString,
  encodeCard,
  newCardId,
  rescheduleCard,
  type MemoryState,
  type Scheduling,
} from "../model/srs";
import { updateWordsTable } from "../obsidian/dictionaryFile";

export interface RescheduleResult {
  /** Cards whose due date moved. */
  moved: number;
  /** Dictionaries that had at least one. */
  files: number;
  /** Dictionaries that could not be written, by path. */
  failed: string[];
}

/**
 * Rewrite the schedule of every review card in `files`.
 *
 * A dictionary is only written when something in it actually moves — the mutator
 * vetoes the write otherwise — so running this twice in a row touches nothing the
 * second time, and a vault whose retention has not changed is left alone entirely.
 *
 * `memoryOf` gives a card's memory state recomputed under new weights, or null to
 * keep the stored one; see `rescheduleCard`.
 */
export async function rescheduleAll(
  app: App,
  files: readonly TFile[],
  scheduling: Scheduling,
  now: Date = new Date(),
  memoryOf: (id: string | null, card: Card) => MemoryState | null = () => null,
): Promise<RescheduleResult> {
  const result: RescheduleResult = { moved: 0, files: 0, failed: [] };
  for (const file of files) {
    let moved = 0;
    try {
      await updateWordsTable(app, file, (table) => {
        if (!table.headers.includes(SRS_COLUMN)) return false;
        const hasDue = table.headers.includes(DUE_COLUMN);
        for (const row of table.rows) {
          const cell = row[SRS_COLUMN] ?? "";
          const card = decodeCard(cell);
          if (!card) continue;
          const id = cardIdFromCell(cell);
          const next = rescheduleCard(card, scheduling, now, memoryOf(id, card));
          if (!next) continue;
          row[SRS_COLUMN] = encodeCard(next, id ?? newCardId());
          if (hasDue) row[DUE_COLUMN] = dueDateString(next);
          moved += 1;
        }
        // Nothing moved, nothing written: this runs over every dictionary in the
        // vault, and a command that reports "already up to date" must not leave a
        // trail of rewritten files behind it.
        return moved > 0;
      });
    } catch {
      // One unwritable note must not abandon the rest: the point of the command is
      // to leave the whole vault consistent, and stopping halfway is the one outcome
      // worse than not running it.
      result.failed.push(file.path);
      continue;
    }
    if (moved > 0) {
      result.moved += moved;
      result.files += 1;
    }
  }
  return result;
}
