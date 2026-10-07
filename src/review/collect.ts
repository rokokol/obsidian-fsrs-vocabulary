import type { App, TFile } from "obsidian";
import type { Card } from "ts-fsrs";
import { isCardRow } from "../model/cards";
import { DUE_COLUMN, SRS_COLUMN } from "../model/dictionary";
import type { ReviewOrder, ReviewPool } from "../model/dictionaryConfig";
import { cardFromCell, cardIdFromCell, dueDateString, encodeCard, newCardId } from "../model/srs";
import { readDictionary, updateWordsTable, type DictionaryDoc } from "../obsidian/dictionaryFile";
import { selectsCard, type ReviewOptions } from "./options";

export interface ReviewItem {
  file: TFile;
  rowIndex: number;
  /**
   * Columns asked before the reveal, and answered after it. Carried per item
   * rather than per session: a vault-wide review spans dictionaries with
   * different columns and different presets. Rows of one dictionary share these
   * arrays, hence readonly.
   */
  frontColumns: readonly string[];
  backColumns: readonly string[];
  /** Whether grading this card writes back to `srs`/`due`. */
  record: boolean;
  /** Raw markdown cell text keyed by content column. */
  fields: Record<string, string>;
  card: Card;
  /**
   * The card's id: the one in its `srs` cell, or a fresh one for a card that has
   * none yet. A fresh id reaches the disk with the first grade.
   */
  cardId: string;
}

/** Decides how a given dictionary is reviewed, from its own headers and config. */
export type ResolveOptions = (doc: DictionaryDoc, headers: string[]) => ReviewOptions;

export interface GatherResult {
  items: ReviewItem[];
  /**
   * Shuffled when any dictionary in the session asked for it. A session has one
   * order, and there is no principled way to pick a winner among dictionaries —
   * so "someone wanted it shuffled" decides.
   */
  order: ReviewOrder;
  /** "due" only when every dictionary drew from its due cards. */
  pool: ReviewPool;
  /** Whether a state filter was applied, so an empty session can say why. */
  filtered: boolean;
}

/**
 * Gather the cards to review across the given dictionaries, in file order. Each
 * dictionary resolves its own layout and card pool; shuffling is left to the
 * caller, so that a vault-wide session mixes dictionaries rather than shuffling
 * each in place.
 */
export async function gatherCards(
  app: App,
  files: TFile[],
  now: Date,
  resolve: ResolveOptions,
): Promise<GatherResult> {
  const items: ReviewItem[] = [];
  let order: ReviewOrder = "file";
  let pool: ReviewPool = "due";
  let filtered = false;

  for (const file of files) {
    const doc = await readDictionary(app, file);
    if (!doc?.table) continue;
    const { headers, rows } = doc.table;
    const options = resolve(doc, headers);
    if (options.frontColumns.length === 0) continue;
    if (options.order === "shuffled") order = "shuffled";
    if (options.pool === "all") pool = "all";
    if (options.states && options.states.length > 0) filtered = true;
    const columns = [...options.frontColumns, ...options.backColumns];

    rows.forEach((row, rowIndex) => {
      if (!isCardRow(row, options.frontColumns)) return;
      const cell = row[SRS_COLUMN] ?? "";
      const card = cardFromCell(cell, now);
      if (!selectsCard(card, options, now)) return;
      const fields: Record<string, string> = {};
      for (const col of columns) fields[col] = row[col] ?? "";
      items.push({
        file,
        rowIndex,
        frontColumns: options.frontColumns,
        backColumns: options.backColumns,
        record: options.record,
        fields,
        card,
        cardId: cardIdFromCell(cell) ?? newCardId(),
      });
    });
  }
  return { items, order, pool, filtered };
}

/** Persist a reviewed card back into its row's `srs` (and mirror `due`). */
export async function writeReview(app: App, item: ReviewItem, card: Card): Promise<void> {
  await updateWordsTable(app, item.file, (table) => {
    if (!table.headers.includes(SRS_COLUMN)) table.headers.push(SRS_COLUMN);
    if (!table.headers.includes(DUE_COLUMN)) table.headers.push(DUE_COLUMN);
    const row = table.rows[item.rowIndex];
    // The row moved or went away between the session gathering it and this write.
    if (!row) return false;
    row[SRS_COLUMN] = encodeCard(card, item.cardId);
    row[DUE_COLUMN] = dueDateString(card);
    return true;
  });
}
