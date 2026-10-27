import type { App, TFile } from "obsidian";
import type { Card } from "ts-fsrs";
import { findCardRow, isCardRow } from "../model/cards";
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
  /**
   * Whether the card comes round again in the same session once its new due
   * date arrives: a recorded review of due cards. See `ReviewQueue`.
   */
  live: boolean;
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
    // A live session also holds the cards that are not due yet, so that one
    // falling due while the session is open is shown in it. The queue decides
    // what is due; here only the state filter applies.
    const live = options.record && options.pool === "due";
    const selection: ReviewOptions = live ? { ...options, pool: "all" } : options;

    rows.forEach((row, rowIndex) => {
      if (!isCardRow(row, options.frontColumns)) return;
      const cell = row[SRS_COLUMN] ?? "";
      const card = cardFromCell(cell, now);
      if (!selectsCard(card, selection, now)) return;
      const fields: Record<string, string> = {};
      for (const col of columns) fields[col] = row[col] ?? "";
      items.push({
        file,
        rowIndex,
        frontColumns: options.frontColumns,
        backColumns: options.backColumns,
        record: options.record,
        live,
        fields,
        card,
        cardId: cardIdFromCell(cell) ?? newCardId(),
      });
    });
  }
  return { items, order, pool, filtered };
}

/**
 * Persist a reviewed card back into its row's `srs` (and mirror `due`). Says
 * whether it did: a row that went away since the session gathered it is not
 * written, and the review then did not happen as far as the log is concerned.
 */
export async function writeReview(app: App, item: ReviewItem, card: Card): Promise<boolean> {
  let written = false;
  await updateWordsTable(app, item.file, (table) => {
    if (!table.headers.includes(SRS_COLUMN)) table.headers.push(SRS_COLUMN);
    if (!table.headers.includes(DUE_COLUMN)) table.headers.push(DUE_COLUMN);
    const front: Record<string, string> = {};
    for (const column of item.frontColumns) front[column] = item.fields[column] ?? "";
    const index = findCardRow(table.rows, item.rowIndex, item.cardId, front);
    const row = table.rows[index];
    // The row went away between the session gathering it and this write.
    if (!row) return false;
    item.rowIndex = index;
    row[SRS_COLUMN] = encodeCard(card, item.cardId);
    row[DUE_COLUMN] = dueDateString(card);
    written = true;
    return true;
  });
  return written;
}
