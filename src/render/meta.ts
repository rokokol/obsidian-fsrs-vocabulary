import { HIDDEN_PROPERTY_KEYS } from "../model/dictionaryConfig";
import { selectProperties } from "../settings";
import { renderProperties } from "./blocks";

/**
 * Render the dictionary header (an `.dictionary-notes-meta` block) from a note's
 * frontmatter into `parent`. The allow-list picks which keys to show and in
 * what order (empty = show every property); nothing is created when no
 * property is selected. Hidden keys are dropped here too, because reading mode
 * hands over raw frontmatter rather than a parsed `DictionaryDoc`.
 * Wikilink/URL values render as links (clicks are handled by the host: the
 * view delegates, reading mode is native).
 */
export function renderDictionaryMeta(
  parent: HTMLElement,
  frontmatter: Record<string, unknown>,
  sourcePath: string,
  allow: string[],
): void {
  const entries = Object.entries(frontmatter).filter(([key]) => !HIDDEN_PROPERTY_KEYS.has(key));
  const selected = selectProperties(entries, allow);
  if (selected.length === 0) return;
  const container = parent.createDiv({ cls: "dictionary-notes-meta" });
  renderProperties(container, selected, sourcePath);
}
