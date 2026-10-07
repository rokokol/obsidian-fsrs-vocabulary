import {
  Component,
  ItemView,
  Keymap,
  MarkdownRenderer,
  Menu,
  Notice,
  setIcon,
  TFile,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import type DictionaryNotesPlugin from "../main";
import {
  contentColumns,
  DUE_COLUMN,
  hasInvalidSrs,
  needsNormalize,
  normalizeWords,
  SRS_COLUMN,
  summaryChanged,
  type NormalizeSummary,
} from "../model/dictionary";
import { toFrontmatterValue } from "../model/dictionaryConfig";
import type { MarkdownTable } from "../model/table";
import { isBlankCell, sanitizeCell } from "../model/word";
import {
  readDictionary,
  updateTheory,
  updateWordsTable,
  type DictionaryDoc,
} from "../obsidian/dictionaryFile";
import { enhanceFieldInput } from "../obsidian/fieldInput";
import { renderCellValue } from "../render/cellValue";
import { renderDictionaryMeta } from "../render/meta";
import { renderStatsGrid, statsForRows } from "../render/statsView";
import { quickOptions } from "../review/options";
import { frontColumnFor, SORT_LABELS, type SortMode } from "../settings";
import { ConfirmModal } from "../ui/confirmModal";
import { promptAddWord, promptImportWords, promptReview, quickReview } from "../ui/prompts";
import { errorMessage, plural } from "../util";
import {
  cardSnapshots,
  planIsEmpty,
  planRender,
  scheduleSnapshot,
  type ViewSnapshot,
} from "./renderPlan";
import { sortRows, type RowEntry } from "./sortRows";

export const DICTIONARY_VIEW_TYPE = "dictionary-notes-view";

/**
 * How long to wait before repainting after a vault event. One edit produces two
 * events — a vault `modify` and a metadata `changed` — a few milliseconds apart,
 * and a review session writes one per graded card; this collapses each burst into
 * a single read of the file.
 */
const REPAINT_DELAY = 150;

/** One rendered card, with the component owning whatever markdown it rendered. */
interface CardEntry {
  el: HTMLElement;
  component: Component;
}

/** The view's fixed sections, created once so a repaint can target just one. */
interface Shell {
  toolbar: HTMLElement;
  stats: HTMLElement;
  theory: HTMLElement;
  meta: HTMLElement;
  cards: HTMLElement;
}

/** Human-readable summary of an auto-cleanup pass, for a Notice. */
function describeNormalize(summary: NormalizeSummary): string {
  const parts: string[] = [];
  if (summary.removedRows > 0) parts.push(`removed ${summary.removedRows} empty row(s)`);
  if (summary.filledCells > 0) {
    parts.push(`filled ${summary.filledCells} blank cell(s) with placeholders`);
  }
  if (summary.removedColumns > 0) {
    parts.push(`removed ${summary.removedColumns} unnamed empty column(s)`);
  }
  return `Cleaned up dictionary: ${parts.join(", ")}.`;
}

/** Remove every drop-position indicator inside `container`. */
function clearDropMarkers(container: HTMLElement): void {
  container.findAll(".drop-before, .drop-after").forEach((el) => {
    el.removeClass("drop-before");
    el.removeClass("drop-after");
  });
}

/**
 * Wire the inline-edit commit gestures onto `el`: blur and Enter finish with
 * save, Escape finishes without. `onFinish` runs exactly once (blur fires
 * again when the element is torn down).
 */
function bindCommitHandlers(el: HTMLElement, onFinish: (save: boolean) => void): void {
  let committed = false;
  const finish = (save: boolean): void => {
    if (committed) return;
    committed = true;
    onFinish(save);
  };
  el.addEventListener("blur", () => {
    finish(true);
  });
  el.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      finish(true);
    } else if (evt.key === "Escape") {
      evt.preventDefault();
      finish(false);
    }
  });
}

/** Interactive, Excalidraw-style dictionary editor bound to a markdown file. */
export class DictionaryEditorView extends ItemView {
  private readonly plugin: DictionaryNotesPlugin;
  private file: TFile | null = null;
  private dragIndex: number | null = null;
  private sortMode: SortMode;
  /**
   * Seed of the random order. Fixed until the reader asks for a new shuffle, so a
   * repaint re-derives the order it already drew instead of moving every card
   * under the cursor whenever a cell is edited.
   */
  private shuffleSeed = Date.now();
  /** The fixed sections, or null when nothing is built yet. */
  private shell: Shell | null = null;
  /** What is on screen. Null forces the next repaint to rebuild everything. */
  private snapshot: ViewSnapshot | null = null;
  private cardEntries: CardEntry[] = [];
  /** Owns the theory's rendered markdown, so re-rendering it releases the old. */
  private theoryComponent: Component | null = null;
  private repaintTimer: number | null = null;
  /**
   * Bumped by every render pass. A pass reads the file across an await, so a newer
   * pass can overtake it; the older one checks this before touching the DOM.
   */
  private generation = 0;
  /**
   * Whether the unreadable-schedule warning has been shown for the file on screen.
   * Not tied to the snapshot: that is nulled by any settings change and by a failed
   * paint, and a ten-second notice per open dictionary on every settings toggle is
   * its own kind of broken.
   */
  private warnedUnreadable = false;

  constructor(leaf: WorkspaceLeaf, plugin: DictionaryNotesPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.sortMode = plugin.settings.defaultSort;
    this.navigation = true;
  }

  getViewType(): string {
    return DICTIONARY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "Dictionary";
  }

  override getIcon(): string {
    return "book-a";
  }

  getFile(): TFile | null {
    return this.file;
  }

  /**
   * Rebuild from scratch — for a settings change, which can alter anything from
   * which properties show to what the stat tiles do, none of it visible in the
   * file the snapshot was taken from.
   */
  refresh(): void {
    this.snapshot = null;
    void this.renderView();
  }

  override getState(): Record<string, unknown> {
    const state = super.getState();
    state["file"] = this.file?.path ?? null;
    return state;
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (typeof state === "object" && state !== null && "file" in state) {
      const path: unknown = state.file;
      if (typeof path === "string") {
        const found = this.app.vault.getAbstractFileByPath(path);
        const next = found instanceof TFile ? found : null;
        // A different file shares no cards with the old one, and its own broken rows
        // are worth a word of their own.
        if (next?.path !== this.file?.path) {
          this.snapshot = null;
          this.warnedUnreadable = false;
        }
        this.file = next;
      }
    }
    await super.setState(state, result);
    await this.renderView();
  }

  override onOpen(): Promise<void> {
    this.addAction("file-code", "Open as markdown", () => {
      const file = this.file;
      if (file) void this.plugin.openAsMarkdown(file, this.leaf);
    });
    // A custom view doesn't get Obsidian's native link handling, so delegate
    // clicks on any rendered link (header properties and card fields alike).
    this.registerDomEvent(this.contentEl, "click", (evt) => {
      this.handleLinkClick(evt);
    });
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === this.file?.path) this.queueRepaint();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path === this.file?.path) this.queueRepaint();
      }),
    );
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    if (this.repaintTimer !== null) window.clearTimeout(this.repaintTimer);
    this.repaintTimer = null;
    // Any pass still reading the file sees a new generation and gives up.
    this.generation += 1;
    this.clearCards();
    this.releaseTheory();
    this.shell = null;
    this.snapshot = null;
    this.contentEl.empty();
    return Promise.resolve();
  }

  /**
   * Repaint soon, once. Coalescing matters because the view's own writes come back
   * to it as events — two per edit — and because a review session writes a card at
   * a time.
   */
  private queueRepaint(): void {
    if (this.repaintTimer !== null) return;
    this.repaintTimer = window.setTimeout(() => {
      this.repaintTimer = null;
      void this.renderView();
    }, REPAINT_DELAY);
  }

  /** Open internal/external links clicked anywhere in the view. */
  private handleLinkClick(evt: MouseEvent): void {
    const anchor = (evt.target as HTMLElement).closest("a");
    if (!anchor) return;
    if (anchor.hasClass("internal-link")) {
      evt.preventDefault();
      const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
      if (href !== "") {
        void this.app.workspace.openLinkText(href, this.file?.path ?? "", Keymap.isModEvent(evt));
      }
    } else if (anchor.hasClass("external-link")) {
      evt.preventDefault();
      const href = anchor.getAttribute("href");
      if (href) window.open(href, "_blank");
    }
  }

  /** Tear the view down to a single message, and forget what was on screen. */
  private showMessage(text: string): void {
    this.clearCards();
    this.releaseTheory();
    this.shell = null;
    this.snapshot = null;
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "dictionary-notes-view-empty", text });
  }

  private async renderView(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const root = this.contentEl;
    root.addClass("dictionary-notes-view");

    const file = this.file;
    if (!file) {
      this.showMessage("No dictionary file.");
      return;
    }
    this.syncHeaderTitle(file);
    let doc: DictionaryDoc | null;
    try {
      doc = await readDictionary(this.app, file);
    } catch (err) {
      // Guarded like the success path below: a read that failed for the file the
      // view has since left would otherwise wipe the newer file's render and
      // leave the pane showing an error about a note it is no longer on.
      if (this.generation !== generation || this.file?.path !== file.path) return;
      const msg = errorMessage(err);
      new Notice(`Failed to read dictionary: ${msg}`);
      this.showMessage(`Failed to read dictionary: ${msg}`);
      return;
    }
    // A read that lost a race must not paint. Two passes overlap easily — a
    // queued repaint and a `setState` from the Back button, say — and the order
    // they finish in has nothing to do with the order they started: a cold read
    // loses to a warm one. Whichever finished last would otherwise be recorded
    // as the truth, so a stale pass could paint one file's words under another
    // file's title, leaving every delete button on screen wired to the wrong
    // file. Neither the file nor the generation is allowed to have moved.
    if (this.generation !== generation || this.file?.path !== file.path) return;
    if (!doc) {
      this.showMessage("This note is not a Dictionary Notes dictionary.");
      return;
    }

    // Clean up rows added by hand in the source (fill gaps, drop empty rows, drop a
    // nameless empty column). Report both what changed and any failure to persist.
    if (doc.table && needsNormalize(doc.table)) {
      const summary = normalizeWords(doc.table);
      if (summaryChanged(summary)) new Notice(describeNormalize(summary));
      void updateWordsTable(this.app, file, (table) =>
        // The table on disk may already be clean — the copy on screen was normalized
        // from a read that raced this write — and re-serializing it for nothing
        // reformats a hand-aligned table and bounces an event back at this view.
        summaryChanged(normalizeWords(table)),
      ).catch((err: unknown) => {
        new Notice(`Failed to clean up the dictionary: ${errorMessage(err)}`);
      });
    }
    // Said once per dictionary opened, not per repaint: the rows are not touched, so
    // the warning would otherwise return on every keystroke until the user fixed a
    // row they may not want to fix now.
    if (doc.table && !this.warnedUnreadable) {
      this.warnedUnreadable = true;
      this.warnUnreadableCards(doc.table);
    }

    const headers = doc.table?.headers ?? [];
    const front = frontColumnFor(headers);
    const backCols = contentColumns(headers).filter((h) => h !== front);
    // A row whose front cell is blank draws no card, so it is not one as far as
    // the snapshot is concerned either — positions have to line up with the DOM.
    // Blankness asked exactly as `isCardRow` asks it, or the two can disagree.
    const entries = this.orderedRows(doc, front).filter(
      ({ row }) => !isBlankCell(row[front] ?? ""),
    );

    const next: ViewSnapshot = {
      headers: [...headers],
      config: JSON.stringify(toFrontmatterValue(doc.frontmatter.config)),
      properties: JSON.stringify(doc.frontmatter.properties),
      theory: doc.theory,
      sort: this.sortMode,
      cards: cardSnapshots(entries, [front, ...backCols]),
      schedule: scheduleSnapshot(doc.table?.rows ?? [], [SRS_COLUMN, DUE_COLUMN]),
    };
    const plan = planRender(this.snapshot, next);
    if (planIsEmpty(plan)) {
      this.snapshot = next;
      return;
    }

    const shell = plan.full || !this.shell ? this.buildShell(root) : this.shell;
    try {
      if (plan.header) {
        shell.toolbar.empty();
        this.renderToolbar(shell.toolbar, file, doc);
        shell.meta.empty();
        renderDictionaryMeta(
          shell.meta,
          doc.frontmatter.properties,
          file.path,
          this.plugin.settings.properties,
        );
        // The view is a column flex with a gap, so a section left empty still
        // claims a gap's worth of space. A dictionary with no properties to show
        // is the normal case for a new one, and a note with no words table has no
        // tiles either — neither should leave a hole.
        shell.meta.toggle(shell.meta.childElementCount > 0);
      }
      if (plan.stats) {
        this.renderStatsPanel(shell.stats, doc, headers);
        shell.stats.toggle(shell.stats.childElementCount > 0);
      }
      if (plan.theory) this.renderTheory(shell.theory, doc, file);
      if (plan.cards) {
        this.renderWords(shell.cards, file, entries, front, backCols);
      } else {
        for (const position of plan.dirty) {
          this.repaintCard(position, file, entries, front, backCols);
        }
      }
    } catch (err) {
      // Recorded only once the screen actually matches. A snapshot written before
      // the paint would claim a half-drawn view was current, and the stale half
      // would never be planned again — the next event would diff against it and
      // come out empty.
      this.snapshot = null;
      // Most callers fire this render without awaiting it, so the rethrow becomes
      // an unhandled rejection with nothing naming the view it came from.
      console.error("Dictionary Notes: failed to render dictionary", file.path, err);
      throw err;
    }
    this.snapshot = next;
  }

  /** Create the fixed sections, in display order, replacing whatever was there. */
  private buildShell(root: HTMLElement): Shell {
    this.clearCards();
    this.releaseTheory();
    root.empty();
    const shell: Shell = {
      toolbar: root.createDiv({ cls: "dictionary-notes-view-toolbar" }),
      stats: root.createDiv(),
      theory: root.createDiv(),
      meta: root.createDiv(),
      cards: root.createDiv({ cls: "dictionary-notes-cards" }),
    };
    this.shell = shell;
    return shell;
  }

  /**
   * Warn about rows whose `srs` cell cannot be read, naming the words.
   *
   * They are reviewed as new cards and the next grade replaces the cell, so nothing
   * is stuck — but the usual cause is a stray `|` further along the row, which has
   * shifted the columns and is worth knowing about before the schedule is rewritten.
   */
  private warnUnreadableCards(table: MarkdownTable): void {
    const front = frontColumnFor(table.headers);
    const broken = table.rows.filter(hasInvalidSrs);
    if (broken.length === 0) return;
    const names = broken
      .slice(0, 3)
      .map((row: Record<string, string>) => row[front] ?? "?")
      .join(", ");
    const rest = broken.length > 3 ? ` and ${(broken.length - 3).toString()} more` : "";
    new Notice(
      `${broken.length.toString()} word${plural(broken.length)} with an unreadable ` +
        `schedule (${names}${rest}). They will be reviewed as new; check those rows ` +
        "for an unescaped |.",
      10000,
    );
  }

  /** Rows paired with their real table index, in the current sort order. */
  private orderedRows(doc: DictionaryDoc, front: string): RowEntry[] {
    const entries: RowEntry[] = (doc.table?.rows ?? []).map((row, index) => ({ row, index }));
    return sortRows(entries, this.sortMode, front, this.shuffleSeed);
  }

  /**
   * The leaf draws its `.view-header-title` once at creation, before the file
   * is set, so it keeps the getDisplayText fallback ("Dictionary"). Own that
   * element: show the file name and make it click-to-rename like markdown mode.
   */
  private syncHeaderTitle(file: TFile): void {
    const titleEl = this.containerEl.querySelector<HTMLElement>(".view-header-title");
    if (!titleEl) return;
    if (!titleEl.hasClass("dictionary-notes-header-title")) {
      titleEl.addClass("dictionary-notes-header-title");
      titleEl.addEventListener("click", () => {
        this.beginHeaderRename(titleEl);
      });
    }
    // Don't clobber the text mid-edit.
    if (titleEl.getAttribute("contenteditable") !== "true") titleEl.setText(file.basename);
  }

  private beginHeaderRename(el: HTMLElement): void {
    const file = this.file;
    if (!file || el.getAttribute("contenteditable") === "true") return;
    el.setAttribute("contenteditable", "true");
    el.setText(file.basename);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    bindCommitHandlers(el, (save) => {
      el.removeAttribute("contenteditable");
      const next = el.textContent.trim();
      if (save && next !== "" && next !== file.basename) void this.rename(file, next);
      else el.setText(file.basename);
    });
  }

  private async rename(file: TFile, basename: string): Promise<void> {
    const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const newPath = `${dir}${basename}.${file.extension}`;
    try {
      await this.app.fileManager.renameFile(file, newPath);
    } catch (err) {
      new Notice(`Rename failed: ${errorMessage(err)}`);
      void this.renderView();
    }
  }

  /** Renders into `bar` itself, which the shell already gave the toolbar class. */
  private renderToolbar(bar: HTMLElement, file: TFile, doc: DictionaryDoc): void {
    this.toolButton(bar, "plus", "Add word", () => {
      this.promptAdd(file, doc);
    });
    this.toolButton(bar, "clipboard-paste", "Import", () => {
      this.promptImport(file, doc);
    });
    this.splitToolButton(
      bar,
      "play",
      "Review",
      () => {
        void this.review(file);
      },
      () => {
        void this.reviewWithOptions(file);
      },
    );
    bar.createDiv({ cls: "dictionary-notes-view-toolbar-spacer" });
    this.renderMuteControl(bar, file, doc);
    this.renderSortControl(bar);
  }

  /** Mute keeps this dictionary out of the due counter and the reminder notices. */
  private renderMuteControl(bar: HTMLElement, file: TFile, doc: DictionaryDoc): void {
    const muted = doc.frontmatter.config.mute;
    const btn = this.toolButton(bar, muted ? "bell-off" : "bell", muted ? "Muted" : "Mute", () => {
      void this.plugin.toggleMute(file);
    });
    btn.setAttribute("aria-label", muted ? "Unmute reminders" : "Mute reminders");
    if (muted) btn.addClass("is-active");
  }

  private renderSortControl(bar: HTMLElement): void {
    this.toolButton(bar, "arrow-up-down", SORT_LABELS[this.sortMode], (evt) => {
      const menu = new Menu();
      for (const [mode, label] of Object.entries(SORT_LABELS)) {
        menu.addItem((item) => {
          item
            .setTitle(label)
            .setChecked(this.sortMode === mode)
            .onClick(() => {
              // Picking Random again is how a reader asks for a different order,
              // so the seed moves on every pick rather than only on a change.
              if (mode === "shuffled") this.shuffleSeed = Date.now();
              this.sortMode = mode as SortMode;
              void this.renderView();
            });
        });
      }
      menu.showAtMouseEvent(evt);
    });
  }

  private toolButton(
    bar: HTMLElement,
    icon: string,
    label: string,
    onClick: (evt: MouseEvent) => void,
  ): HTMLButtonElement {
    const btn = bar.createEl("button", { cls: "dictionary-notes-tool" });
    const iconEl = btn.createSpan({ cls: "dictionary-notes-tool-icon" });
    setIcon(iconEl, icon);
    btn.createSpan({ text: label });
    btn.addEventListener("click", onClick);
    return btn;
  }

  /**
   * A tool button with a caret in its corner: the button does the common thing
   * straight away, the caret opens the dialog for everything else. The caret is
   * its own button so it has its own hit area.
   */
  private splitToolButton(
    bar: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    onCaret: (evt: MouseEvent) => void,
  ): void {
    const wrap = bar.createDiv({ cls: "dictionary-notes-tool-split" });
    this.toolButton(wrap, icon, label, onClick);
    const caret = wrap.createEl("button", {
      cls: "dictionary-notes-tool-caret",
      attr: { "aria-label": `${label} options` },
    });
    setIcon(caret, "chevron-down");
    caret.addEventListener("click", (evt) => {
      evt.stopPropagation();
      onCaret(evt);
    });
  }

  /** Every tile starts the session it counts — the same ones the block renders. */
  private renderStatsPanel(section: HTMLElement, doc: DictionaryDoc, headers: string[]): void {
    section.empty();
    if (!doc.table) return;
    const front = quickOptions(doc.frontmatter.config, headers).frontColumns;
    const stats = statsForRows(doc.table.rows, front, new Date());
    const panel = section.createDiv({ cls: "dictionary-notes-view-stats" });
    renderStatsGrid(panel, stats, this.plugin.statActions([doc.file]));
  }

  /**
   * Release the theory's markdown. Rendered markdown registers child components
   * for embeds and the like; without unloading them each repaint would leave the
   * last one's behind, and the view outlives every repaint.
   */
  private releaseTheory(): void {
    if (!this.theoryComponent) return;
    this.removeChild(this.theoryComponent);
    this.theoryComponent = null;
  }

  private renderTheory(root: HTMLElement, doc: DictionaryDoc, file: TFile): void {
    this.releaseTheory();
    root.empty();
    const component = this.addChild(new Component());
    this.theoryComponent = component;

    const hasTheory = doc.theory.trim() !== "";
    const section = root.createDiv({ cls: "dictionary-notes-view-theory" });

    const bar = section.createDiv({ cls: "dictionary-notes-theory-bar" });
    const editBtn = bar.createEl("button", {
      cls: "dictionary-notes-theory-edit",
      attr: { "aria-label": "Edit theory" },
    });
    setIcon(editBtn, "pencil");

    const bodyEl = section.createDiv({ cls: "dictionary-notes-theory-body" });
    if (hasTheory) {
      void MarkdownRenderer.render(this.app, doc.theory, bodyEl, file.path, component);
    } else {
      bodyEl.createDiv({ cls: "dictionary-notes-view-empty is-inline", text: "Add theory…" });
    }

    const startEdit = (): void => {
      this.beginTheoryEdit(bodyEl, file, doc.theory);
    };
    editBtn.addEventListener("click", startEdit);
    if (!hasTheory) bodyEl.addEventListener("click", startEdit);
  }

  private beginTheoryEdit(bodyEl: HTMLElement, file: TFile, theory: string): void {
    bodyEl.empty();
    const textarea = bodyEl.createEl("textarea", { cls: "dictionary-notes-theory-input" });
    textarea.value = theory;
    textarea.rows = Math.max(3, theory.split("\n").length + 1);
    textarea.focus();
    enhanceFieldInput(this.app, textarea, file.path);

    const controls = bodyEl.createDiv({ cls: "dictionary-notes-theory-controls" });
    const save = controls.createEl("button", { cls: "mod-cta", text: "Save" });
    const cancel = controls.createEl("button", { text: "Cancel" });
    save.addEventListener("click", () => {
      void updateTheory(this.app, file, textarea.value);
    });
    cancel.addEventListener("click", () => {
      void this.renderView();
    });
  }

  /** Unload every card's markdown and drop the elements. */
  private clearCards(): void {
    for (const entry of this.cardEntries) this.removeChild(entry.component);
    this.cardEntries = [];
    // The dragged handle is gone, so its `dragend` will never fire. Left set, the
    // index would make the next drag over a card — a file from the explorer, text
    // from another pane — look like a reorder of a row that has since moved.
    this.dragIndex = null;
  }

  private renderWords(
    list: HTMLElement,
    file: TFile,
    entries: RowEntry[],
    front: string,
    backCols: string[],
  ): void {
    this.clearCards();
    list.empty();
    if (entries.length === 0) {
      list.createDiv({
        cls: "dictionary-notes-view-empty",
        text: 'No words yet — use "Add word".',
      });
      return;
    }
    for (const entry of entries) {
      const card = this.buildCard(file, entry, front, backCols);
      list.appendChild(card.el);
      this.cardEntries.push(card);
    }
  }

  /**
   * Replace one card in place. This is what the render plan is for: an edited cell
   * repaints that card and leaves the rest of the list — and all of its rendered
   * markdown — alone. A grade never comes through here; no card shows `srs`/`due`,
   * so the schedule moves the stat tiles only.
   */
  private repaintCard(
    position: number,
    file: TFile,
    entries: RowEntry[],
    front: string,
    backCols: string[],
  ): void {
    const old = this.cardEntries[position];
    const entry = entries[position];
    // A detached card would make `replaceWith` a silent no-op, leaving the new
    // card's component parented to the view while `cardEntries` claimed it was on
    // screen. Nothing reaches here that way today; the check is what keeps that
    // true rather than something to be rediscovered.
    if (!old?.el.parentElement || !entry) return;
    const next = this.buildCard(file, entry, front, backCols);
    old.el.replaceWith(next.el);
    this.removeChild(old.component);
    this.cardEntries[position] = next;
  }

  /**
   * One card, detached, owning a component for the markdown its cells render. The
   * component is a child of the view so it unloads with it, and is removed when the
   * card goes — otherwise every repaint would leave the previous render's embeds
   * registered on a view that lives as long as the leaf does, which is what made a
   * long editing session progressively slower.
   */
  private buildCard(
    file: TFile,
    { row, index: rowIndex }: RowEntry,
    front: string,
    backCols: string[],
  ): CardEntry {
    const component = this.addChild(new Component());
    const card = createDiv({ cls: "dictionary-notes-card dictionary-notes-card-editable" });
    if (this.sortMode === "manual") {
      this.attachDragTarget(card, file, rowIndex);
      const handle = card.createDiv({
        cls: "dictionary-notes-card-handle",
        attr: { "aria-label": "Drag to reorder", draggable: "true" },
      });
      setIcon(handle, "grip-vertical");
      handle.addEventListener("dragstart", (evt) => {
        this.dragIndex = rowIndex;
        card.addClass("is-dragging");
        evt.dataTransfer?.setData("text/plain", rowIndex.toString());
        if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
      });
      handle.addEventListener("dragend", () => {
        this.dragIndex = null;
        card.removeClass("is-dragging");
        if (card.parentElement) clearDropMarkers(card.parentElement);
      });
    }

    const del = card.createEl("button", {
      cls: "dictionary-notes-card-delete",
      attr: { "aria-label": "Delete word" },
    });
    setIcon(del, "trash-2");
    const word = (row[front] ?? "").trim();
    del.addEventListener("click", () => {
      new ConfirmModal(this.app, `Delete "${word}"?`, "Delete", () => {
        void this.deleteWord(file, rowIndex);
      }).open();
    });

    const frontEl = card.createDiv({ cls: "dictionary-notes-word" });
    this.renderEditable(frontEl, component, file, rowIndex, front, row[front] ?? "");

    const fields = card.createDiv({ cls: "dictionary-notes-fields" });
    for (const col of backCols) {
      const field = fields.createDiv({ cls: "dictionary-notes-field" });
      field.createSpan({ cls: "dictionary-notes-field-name", text: col });
      const valueEl = field.createSpan({ cls: "dictionary-notes-field-value" });
      this.renderEditable(valueEl, component, file, rowIndex, col, row[col] ?? "");
    }
    return { el: card, component };
  }

  private renderEditable(
    el: HTMLElement,
    component: Component,
    file: TFile,
    rowIndex: number,
    column: string,
    value: string,
  ): void {
    el.empty();
    el.addClass("dictionary-notes-editable");
    if (value.trim() === "") {
      el.addClass("is-empty");
      el.setText("…");
    } else {
      el.removeClass("is-empty");
      renderCellValue(this.app, el, value, file.path, component);
    }
    el.addEventListener("click", (evt) => {
      const target = evt.target as HTMLElement;
      if (target.closest("audio, video, img, a, .internal-embed, input")) return;
      this.beginEdit(el, component, file, rowIndex, column, value);
    });
  }

  private beginEdit(
    el: HTMLElement,
    component: Component,
    file: TFile,
    rowIndex: number,
    column: string,
    value: string,
  ): void {
    el.empty();
    el.removeClass("is-empty");
    const input = el.createEl("input", { cls: "dictionary-notes-edit-input", type: "text" });
    input.value = value;
    input.focus();
    input.select();
    enhanceFieldInput(this.app, input, file.path);

    bindCommitHandlers(input, (save) => {
      const next = sanitizeCell(input.value);
      // Clearing a field would orphan the row (a blank front hides the card),
      // so an empty edit reverts to the previous value instead of saving.
      if (save && next !== "" && next !== value) {
        void this.editCell(file, rowIndex, column, next);
      } else {
        this.renderEditable(el, component, file, rowIndex, column, value);
      }
    });
  }

  private async editCell(
    file: TFile,
    rowIndex: number,
    column: string,
    value: string,
  ): Promise<void> {
    await updateWordsTable(this.app, file, (table) => {
      const row = table.rows[rowIndex];
      // The row went away while the field was being edited; adding the column for a
      // value nobody will hold is not a change worth writing.
      if (!row) return false;
      if (!table.headers.includes(column)) table.headers.push(column);
      row[column] = value;
      return true;
    });
  }

  private async deleteWord(file: TFile, rowIndex: number): Promise<void> {
    await updateWordsTable(this.app, file, (table) => {
      if (rowIndex < 0 || rowIndex >= table.rows.length) return false;
      table.rows.splice(rowIndex, 1);
      return true;
    });
  }

  /** True when the pointer is past the card's horizontal midpoint (insert after). */
  private static isAfter(card: HTMLElement, clientX: number): boolean {
    const rect = card.getBoundingClientRect();
    return clientX > rect.left + rect.width / 2;
  }

  private attachDragTarget(card: HTMLElement, file: TFile, rowIndex: number): void {
    card.addEventListener("dragover", (evt) => {
      if (this.dragIndex === null || this.dragIndex === rowIndex) return;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
      const after = DictionaryEditorView.isAfter(card, evt.clientX);
      // No-op when the indicator is already correct — avoids repaint flicker as
      // the pointer moves across the card's children (which fire dragenter).
      if (card.hasClass(after ? "drop-after" : "drop-before")) return;
      if (card.parentElement) clearDropMarkers(card.parentElement);
      card.toggleClass("drop-after", after);
      card.toggleClass("drop-before", !after);
    });
    card.addEventListener("drop", (evt) => {
      evt.preventDefault();
      card.removeClass("drop-before");
      card.removeClass("drop-after");
      const from = this.dragIndex;
      this.dragIndex = null;
      if (from === null) return;
      const insertBefore = rowIndex + (DictionaryEditorView.isAfter(card, evt.clientX) ? 1 : 0);
      void this.reorder(file, from, insertBefore);
    });
  }

  /** Move row `from` so it lands at pre-removal index `insertBefore`. */
  private async reorder(file: TFile, from: number, insertBefore: number): Promise<void> {
    await updateWordsTable(this.app, file, (table) => {
      if (from < 0 || from >= table.rows.length) return false;
      const [moved] = table.rows.splice(from, 1);
      if (!moved) return false;
      const idx = from < insertBefore ? insertBefore - 1 : insertBefore;
      table.rows.splice(Math.max(0, Math.min(idx, table.rows.length)), 0, moved);
      return true;
    });
  }

  private promptAdd(file: TFile, doc: DictionaryDoc): void {
    promptAddWord(this.app, file, doc, this.plugin.settings.newDictionaryColumns);
  }

  private promptImport(file: TFile, doc: DictionaryDoc): void {
    promptImportWords(this.app, file, doc, this.plugin.settings.newDictionaryColumns);
  }

  private async review(file: TFile): Promise<void> {
    await quickReview(this.app, [file], this.plugin.reviewPrefs());
  }

  private async reviewWithOptions(file: TFile): Promise<void> {
    await promptReview(this.app, [file], this.plugin.reviewPrefs());
  }
}
