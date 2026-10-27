/**
 * Reading a words table as a set of cards: a row is a card when at least one of
 * the columns the card asks with is filled, and its schedule comes from the
 * `srs` cell (empty = a brand-new card).
 *
 * Shared on purpose. The stats tiles, the dashboard, the status-bar counter and
 * the session a click on any of them starts must agree on which rows count —
 * they are read side by side, and a second copy of this rule would let a tile
 * promise a number the session it opens does not deliver.
 */

import type { Card } from "ts-fsrs";
import { SRS_COLUMN } from "./dictionary";
import { cardFromCell, cardIdFromCell } from "./srs";
import { isBlankCell } from "./word";

/** Whether a row is a card at all, given the columns its front is made of. */
export function isCardRow(row: Record<string, string>, front: readonly string[]): boolean {
  return front.some((column) => !isBlankCell(row[column] ?? ""));
}

/**
 * The index of the row that holds a card, or -1 when it is gone. The row at
 * `rowIndex` is where the card was when it was read; a sort or an edit from
 * outside can move it while a session is open, and a write to that index would
 * then land on another word. A row with an id in its `srs` cell is matched by
 * that id alone, since two rows can share a word; a row without one, by the
 * card's front cells.
 */
export function findCardRow(
  rows: Record<string, string>[],
  rowIndex: number,
  cardId: string,
  front: Record<string, string>,
): number {
  const holds = (row: Record<string, string>): boolean => {
    const id = cardIdFromCell(row[SRS_COLUMN] ?? "");
    if (id !== null) return id === cardId;
    return Object.entries(front).every(([column, value]) => (row[column] ?? "") === value);
  };
  const remembered = rows[rowIndex];
  if (remembered && holds(remembered)) return rowIndex;
  return rows.findIndex(holds);
}

/** Every card in `rows`, in file order. */
export function tableCards(
  rows: Record<string, string>[],
  front: readonly string[],
  now: Date,
): Card[] {
  const cards: Card[] = [];
  for (const row of rows) {
    if (!isCardRow(row, front)) continue;
    cards.push(cardFromCell(row[SRS_COLUMN] ?? "", now));
  }
  return cards;
}
