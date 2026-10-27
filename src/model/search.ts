/**
 * The search field of the dictionary view: which rows a query keeps.
 *
 * A filter, not a ranking. The cards stay in the order the reader chose, and a
 * row either shows or does not, so a plain substring test is what fits: it is
 * predictable while typing, where a fuzzy match would keep cards the reader
 * cannot see a reason for.
 */

/** Lower case, with ё read as е: Russian text spells the same word either way. */
function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/**
 * A test for rows against `query`. Every whitespace-separated word of the query
 * has to appear in one of `columns`, in any order, so "off взлет" finds a phrasal
 * verb by a word of it and a word of its translation. A blank query keeps every row.
 */
export function wordMatcher(
  query: string,
  columns: readonly string[],
): (row: Record<string, string>) => boolean {
  const words = fold(query)
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return () => true;
  return (row) => {
    const cells = columns.map((column) => fold(row[column] ?? ""));
    return words.every((word) => cells.some((cell) => cell.includes(word)));
  };
}
