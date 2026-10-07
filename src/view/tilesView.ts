import { ItemView, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type FsrsVocabularyPlugin from "../main";
import { addIconicReloadAction } from "../obsidian/iconic";
import { renderDictionaryTiles, type TileInfo } from "../render/dictionaryTile";
import { quickReview } from "../ui/prompts";
import { collectRows, NO_DICTIONARIES, REDRAW_DELAY } from "./dictionaryList";

export const TILES_VIEW_TYPE = "fsrs-vocabulary-tiles";

/**
 * Dictionaries only, as tiles.
 *
 * The split is Iconic's: a dictionary the user bothered to give an icon gets a
 * picture tile, and the rest fall into a single-column list of text tiles below.
 * That way the shelf reflects a decision the user already made in another plugin
 * instead of asking them to make the same one twice — and a vault with no icons
 * degrades to a plain list rather than a grid of identical blank squares.
 */
export class DictionaryTilesView extends ItemView {
  private readonly plugin: FsrsVocabularyPlugin;
  private redrawTimer: number | null = null;
  /** Bumped per render; an older pass checks it before touching the DOM again. */
  private generation = 0;
  /** Paths on screen, so an edit that unmakes a dictionary still redraws. */
  private shown = new Set<string>();
  /** The "Reload icons" button, hidden while the integration is off. */
  private reloadAction: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: FsrsVocabularyPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }

  getViewType(): string {
    return TILES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Dictionaries";
  }

  override getIcon(): string {
    return "library-big";
  }

  override onOpen(): Promise<void> {
    // Nothing tells us when an icon changes: Iconic's data lives under the config
    // folder, which raises no vault events. So offer the reload explicitly.
    this.reloadAction = addIconicReloadAction(this, this.plugin);
    const onEdit = (file: TAbstractFile): void => {
      if (this.plugin.cache.has(file.path) || this.shown.has(file.path)) this.queueRedraw();
    };
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
    this.generation += 1;
    // Obsidian removes the header button itself; dropping the handle keeps a late
    // render from styling a detached element.
    this.reloadAction = null;
    this.contentEl.empty();
    return Promise.resolve();
  }

  /** Repaint on demand — a settings toggle or a Reload icons click, from either
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
    root.addClass("fsrs-vocabulary-tiles-view");

    const files = this.plugin.cache.files();
    if (files.length === 0) {
      this.shown.clear();
      root.createDiv({ cls: "fsrs-vocabulary-view-empty", text: NO_DICTIONARIES });
      return;
    }

    // With the integration off, nothing has an icon, so every dictionary falls
    // through to the text list.
    const icons = await this.plugin.iconicIcons();
    if (!current()) return;

    const rows = await collectRows(this.app, files, new Date());
    if (!current()) return;
    const tiles: TileInfo[] = rows.map((row) => ({
      ...row,
      icon: icons.get(row.file.path) ?? null,
    }));
    this.shown = new Set(tiles.map((tile) => tile.file.path));

    renderDictionaryTiles(this.app, root, tiles, (tile) => ({
      icon: "play",
      label: `Quick review of ${tile.file.basename}`,
      run: () => {
        void quickReview(this.app, [tile.file], this.plugin.reviewPrefs());
      },
    }));
  }
}
