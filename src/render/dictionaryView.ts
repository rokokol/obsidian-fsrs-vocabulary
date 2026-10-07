import { setIcon, type MarkdownPostProcessorContext } from "obsidian";
import { isManagedColumn, SRS_COLUMN } from "../model/dictionary";
import { marksDictionary } from "../model/dictionaryConfig";
import { frontColumnFor } from "../settings";
import { renderDictionaryMeta } from "./meta";

/** Whether the Review button was pressed, or its options caret. */
export type ReviewMode = "quick" | "options";

function getFrontmatter(ctx: MarkdownPostProcessorContext): Record<string, unknown> | null {
  const fm: unknown = ctx.frontmatter;
  if (typeof fm !== "object" || fm === null) return null;
  return fm as Record<string, unknown>;
}

/** A table is the words table if it carries the front column and an srs column. */
function isWordsTable(headers: string[], front: string): boolean {
  return headers.includes(front) && headers.includes(SRS_COLUMN);
}

function readHeaders(table: HTMLTableElement): string[] {
  return Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
}

/**
 * Transform a words table into a styled dictionary. Cell DOM (including
 * Obsidian-rendered embeds/audio/images) is moved into the new layout, so
 * attachments keep working.
 */
function renderCards(table: HTMLTableElement, headers: string[], front: string): HTMLElement {
  const list = createDiv({ cls: "fsrs-vocabulary-cards" });
  const backColumns = headers.filter((h) => h !== front && !isManagedColumn(h));

  for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
    const cells = Array.from(tr.children);
    const byName = new Map<string, Element>();
    headers.forEach((name, idx) => {
      const cell = cells[idx];
      if (cell) byName.set(name, cell);
    });

    const card = list.createDiv({ cls: "fsrs-vocabulary-card" });
    const frontCell = byName.get(front);
    const frontEl = card.createDiv({ cls: "fsrs-vocabulary-word" });
    if (frontCell) moveChildren(frontCell, frontEl);

    const fields = card.createDiv({ cls: "fsrs-vocabulary-fields" });
    for (const name of backColumns) {
      const cell = byName.get(name);
      if (!cell || cell.textContent.trim() === "") continue;
      const field = fields.createDiv({ cls: "fsrs-vocabulary-field" });
      field.createSpan({ cls: "fsrs-vocabulary-field-name", text: name });
      const valueEl = field.createSpan({ cls: "fsrs-vocabulary-field-value" });
      moveChildren(cell, valueEl);
    }
  }
  return list;
}

function moveChildren(from: Element, to: HTMLElement): void {
  while (from.firstChild) to.appendChild(from.firstChild);
}

/**
 * Markdown post-processor: renders dictionary notes as styled dictionaries in
 * reading mode. Theory and other markdown render natively; only the words
 * table is transformed.
 */
export function renderDictionary(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  onReview?: (sourcePath: string, mode: ReviewMode) => void,
  allowProperties: string[] = [],
): void {
  const fm = getFrontmatter(ctx);
  if (!fm || !marksDictionary(fm)) return;

  // The selector already types these as tables; an `instanceof` check on top of it
  // would fail for a table that lives in a popout window
  const tables = Array.from(el.querySelectorAll("table"));
  for (const table of tables) {
    if (table.dataset["fsrsVocabulary"] === "done") continue;
    const headers = readHeaders(table);
    const front = frontColumnFor(headers);
    if (!isWordsTable(headers, front)) continue;

    const container = createDiv({ cls: "fsrs-vocabulary-dictionary" });
    container.dataset["fsrsVocabulary"] = "done";

    if (onReview) {
      const toolbar = container.createDiv({ cls: "fsrs-vocabulary-toolbar" });
      const split = toolbar.createDiv({ cls: "fsrs-vocabulary-tool-split" });
      const btn = split.createEl("button", { cls: "fsrs-vocabulary-review-btn", text: "Review" });
      btn.addEventListener("click", () => {
        onReview(ctx.sourcePath, "quick");
      });
      const caret = split.createEl("button", {
        cls: "fsrs-vocabulary-tool-caret",
        attr: { "aria-label": "Review options" },
      });
      setIcon(caret, "chevron-down");
      caret.addEventListener("click", (evt) => {
        evt.stopPropagation();
        onReview(ctx.sourcePath, "options");
      });
    }

    renderDictionaryMeta(container, fm, ctx.sourcePath, allowProperties);
    container.appendChild(renderCards(table, headers, front));
    table.replaceWith(container);
  }
}
