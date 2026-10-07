import { ItemView, Keymap, setIcon, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type FsrsVocabularyPlugin from "../main";
import { countedDictionaries } from "../model/dictionaryConfig";
import type { IconicIcon } from "../model/iconic";
import { addIconicReloadAction } from "../obsidian/iconic";
import { renderIconicIcon } from "../render/iconicIcon";
import { renderStatsGrid, type Stats } from "../render/statsView";
import { quickReview, reviewSlice } from "../ui/prompts";
import { collectRows, NO_DICTIONARIES, REDRAW_DELAY, type DictionaryRow } from "./dictionaryList";

export const DASHBOARD_VIEW_TYPE = "fsrs-vocabulary-dashboard";

function sumStats(rows: DictionaryRow[]): Stats {
  const total: Stats = { total: 0, fresh: 0, learning: 0, review: 0, relearning: 0, due: 0 };
  for (const row of rows) {
    for (const key of Object.keys(total) as (keyof Stats)[]) total[key] += row.stats[key];
  }
  return total;
}

/**
 * Vault-wide overview: totals across every dictionary, then a row per dictionary
 * with its own numbers, a way in, and a review button.
 */
export class DashboardView extends ItemView {
  private readonly plugin: FsrsVocabularyPlugin;
  private redrawTimer: number | null = null;
  /**
   * Bumped by every render. A pass reads dictionaries one await at a time, so a
   * newer pass can empty the container while an older one is still mid-loop;
   * the older pass checks this before touching the DOM again and gives up.
   */
  private generation = 0;
  /** Paths currently on screen, so an edit that unmakes a dictionary redraws. */
  private shown = new Set<string>();
  /** The "Reload icons" button, hidden while the integration is off. */
  private reloadAction: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: FsrsVocabularyPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Vocabulary dashboard";
  }

  override getIcon(): string {
    return "layout-dashboard";
  }

  override onOpen(): Promise<void> {
    // Nothing tells us when an icon changes: Iconic's data lives under the config
    // folder, which raises no vault events. So offer the reload explicitly.
    this.reloadAction = addIconicReloadAction(this, this.plugin);
    // Numbers here are derived from the notes, so anything that edits a
    // dictionary invalidates them. Coalesce: a review session writes per card.
    // Edits are filtered to dictionaries — with the dashboard docked, typing in
    // any note at all would otherwise re-read the whole vault every 400 ms.
    // The note that just stopped being a dictionary is already out of the cache
    // by the time this runs, so `shown` catches it: without that its row would
    // sit there until some other dictionary happened to change.
    const onEdit = (file: TAbstractFile): void => {
      if (this.plugin.cache.has(file.path) || this.shown.has(file.path)) this.queueRedraw();
    };
    // A deleted or renamed note is in neither list under its new name, and
    // either can change which dictionaries exist.
    const onMove = (): void => {
      this.queueRedraw();
    };
    this.registerEvent(this.app.vault.on("modify", onEdit));
    this.registerEvent(this.app.metadataCache.on("changed", onEdit));
    this.registerEvent(this.app.vault.on("delete", onMove));
    this.registerEvent(this.app.vault.on("rename", onMove));
    return this.render();
  }

  override onClose(): Promise<void> {
    if (this.redrawTimer !== null) window.clearTimeout(this.redrawTimer);
    this.redrawTimer = null;
    // Any pass still in flight sees a new generation and stops.
    this.generation += 1;
    // Obsidian removes the header button itself; dropping the handle keeps a late
    // render from styling a detached element.
    this.reloadAction = null;
    this.contentEl.empty();
    return Promise.resolve();
  }

  /** Repaint on demand — a settings change or a Reload icons click, from either
   * view that draws icons, rather than a vault event. */
  redraw(): void {
    this.queueRedraw();
  }

  private queueRedraw(): void {
    if (this.redrawTimer !== null) return;
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = null;
      void this.render();
    }, REDRAW_DELAY);
  }

  private async render(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const current = (): boolean => this.generation === generation;

    const useIconic = this.plugin.settings.iconicIntegration;
    // The action exists for a change no vault event reports; with the integration
    // off there is no such change, and offering to reload nothing would be a lie.
    this.reloadAction?.toggle(useIconic);

    const root = this.contentEl;
    root.empty();
    root.addClass("fsrs-vocabulary-dashboard");

    const files = this.plugin.cache.files();
    if (files.length === 0) {
      this.shown.clear();
      root.createDiv({ cls: "fsrs-vocabulary-view-empty", text: NO_DICTIONARIES });
      return;
    }

    // With the integration off, no row has an icon.
    const icons = await this.plugin.iconicIcons();
    if (!current()) return;

    const rows = await collectRows(this.app, files, new Date());
    if (!current()) return;
    this.shown = new Set(rows.map((row) => row.file.path));

    root.createEl("h2", { text: "Dictionaries" });
    // The totals count what the reminders count, so the two never disagree; the
    // table below still lists every dictionary, muted ones marked.
    const counted = countedDictionaries(
      rows,
      (row) => row.muted,
      this.plugin.settings.statsIncludeMuted,
    );
    const countedFiles = counted.map((row) => row.file);
    // Summed from the rows rather than read again: `statsForFiles` would parse
    // every dictionary a second time, with the pane blank meanwhile.
    renderStatsGrid(root, sumStats(counted), this.plugin.statActions(countedFiles));

    const bar = root.createDiv({ cls: "fsrs-vocabulary-dashboard-bar" });
    const reviewAll = bar.createEl("button", { cls: "mod-cta", text: "Review everything due" });
    reviewAll.addEventListener("click", () => {
      void reviewSlice(this.app, countedFiles, this.plugin.reviewPrefs(), { pool: "due" });
    });

    this.renderTable(root, rows, icons);
  }

  private renderTable(
    root: HTMLElement,
    rows: DictionaryRow[],
    icons: Map<string, IconicIcon>,
  ): void {
    // Once one row is indented by an icon, every row is: names that start at two
    // different places read as two different columns. Nothing is reserved when no
    // dictionary has an icon, so a vault without them keeps the tighter table.
    const anyIcon = rows.some((row) => icons.has(row.file.path));
    const table = root.createEl("table", { cls: "fsrs-vocabulary-dashboard-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const label of ["Dictionary", "Total", "Due", "New", "Learning", "Review", ""]) {
      head.createEl("th", { text: label });
    }
    const body = table.createEl("tbody");

    for (const row of rows) {
      const tr = body.createEl("tr");
      if (row.muted) tr.addClass("is-muted");

      const nameCell = tr.createEl("td");
      if (anyIcon) {
        // Aria-hidden: the icon says nothing the name beside it does not, and a
        // Lucide id read aloud before every dictionary would be noise.
        const iconEl = nameCell.createSpan({
          cls: "fsrs-vocabulary-dashboard-icon",
          attr: { "aria-hidden": "true" },
        });
        const icon = icons.get(row.file.path);
        if (icon) renderIconicIcon(iconEl, icon);
      }
      // An href makes the link keyboard-reachable; navigation is ours, so the
      // default is always prevented.
      const link = nameCell.createEl("a", {
        cls: "fsrs-vocabulary-dashboard-link",
        text: row.file.basename,
        href: "#",
      });
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(row.file);
      });
      // The dashboard counts muted dictionaries; the reminders do not. Say so,
      // or the two numbers just disagree.
      if (row.muted) {
        nameCell.createSpan({
          cls: "fsrs-vocabulary-dashboard-badge",
          text: "muted",
          attr: { "aria-label": "Left out of reminders and the due counter" },
        });
      }

      tr.createEl("td", { text: row.stats.total.toString() });
      tr.createEl("td", { text: row.stats.due.toString() });
      tr.createEl("td", { text: row.stats.fresh.toString() });
      tr.createEl("td", { text: (row.stats.learning + row.stats.relearning).toString() });
      tr.createEl("td", { text: row.stats.review.toString() });

      const actions = tr.createEl("td", { cls: "fsrs-vocabulary-dashboard-actions" });
      // The dictionary's own Review button, from here: its quick preset, which
      // is not necessarily the due cards — hence "quick", not "review due".
      const review = actions.createEl("button", {
        cls: "fsrs-vocabulary-dashboard-review",
        attr: { "aria-label": `Quick review of ${row.file.basename}` },
      });
      setIcon(review, "play");
      review.addEventListener("click", () => {
        void quickReview(this.app, [row.file], this.plugin.reviewPrefs());
      });

      const mute = actions.createEl("button", {
        cls: "fsrs-vocabulary-dashboard-mute",
        attr: {
          "aria-label": row.muted ? `Unmute ${row.file.basename}` : `Mute ${row.file.basename}`,
        },
      });
      setIcon(mute, row.muted ? "bell-off" : "bell");
      mute.addEventListener("click", () => {
        void this.toggleMute(row);
      });
    }
  }

  /**
   * No redraw here on purpose: the row is drawn from the metadata cache, which
   * lags the write by a beat, so redrawing now would repaint the old state. The
   * `changed` event this write raises brings the table up to date.
   */
  private async toggleMute(row: DictionaryRow): Promise<void> {
    await this.plugin.toggleMute(row.file);
  }
}
