/**
 * The dictionary tile: a link to one dictionary that shows what is waiting in it.
 *
 * Shared by the shelf and the stats block so a dictionary looks the same wherever
 * it is offered. Both need the icon, the counts, the muted badge and the click
 * target; the only difference is the corner action, which the shelf supplies.
 */

import { Keymap, setIcon, type App, type TFile } from "obsidian";
import type { IconicIcon } from "../model/iconic";
import { renderIconicIcon } from "./iconicIcon";
import type { Stats } from "./statsView";

/** One dictionary, as a tile needs to know it. */
export interface TileInfo {
  file: TFile;
  /** Its Iconic icon, when the integration is on and it has one. */
  icon: IconicIcon | null;
  /** Counts to show, or null to show none (a bare link tile). */
  stats: Stats | null;
  muted: boolean;
}

export interface TileOptions {
  /** Lay the tile out as a list row rather than a grid cell. */
  flat?: boolean;
  /** A corner button: its icon, its label, and what it does. */
  action?: { icon: string; label: string; run: () => void };
}

/**
 * Append a tile to `container`. The markup is the same for a grid cell and a list
 * row — they differ only in how their container lays them out — so the click
 * target, the badge and the action stay identical between the two.
 */
export function renderDictionaryTile(
  app: App,
  container: HTMLElement,
  info: TileInfo,
  options: TileOptions = {},
): HTMLElement {
  const classes = ["fsrs-vocabulary-tile"];
  if (options.flat === true) classes.push("is-flat");
  if (info.muted) classes.push("is-muted");
  const el = container.createEl("a", { cls: classes.join(" "), href: "#" });
  // An href makes the tile keyboard-reachable; navigation is ours, so the default
  // is always prevented.
  el.addEventListener("click", (evt) => {
    evt.preventDefault();
    void app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(info.file);
  });

  if (info.icon) renderIconicIcon(el.createDiv({ cls: "fsrs-vocabulary-tile-icon" }), info.icon);

  const body = el.createDiv({ cls: "fsrs-vocabulary-tile-body" });
  body.createDiv({ cls: "fsrs-vocabulary-tile-name", text: info.file.basename });
  const stats = info.stats;
  if (stats || info.muted) {
    const meta = body.createDiv({ cls: "fsrs-vocabulary-tile-meta" });
    // Due first: it is the only number that asks anything of the reader.
    if (stats && stats.due > 0) {
      meta.createSpan({ cls: "fsrs-vocabulary-tile-due", text: `${stats.due.toString()} due` });
    }
    if (stats) meta.createSpan({ text: `${stats.total.toString()} words` });
    if (info.muted) meta.createSpan({ cls: "fsrs-vocabulary-tile-badge", text: "muted" });
  }

  const action = options.action;
  if (action) {
    const button = el.createEl("button", {
      cls: "fsrs-vocabulary-tile-review",
      attr: { "aria-label": action.label },
    });
    setIcon(button, action.icon);
    button.addEventListener("click", (evt) => {
      // The tile itself is a link; without this the action's click would open the
      // note behind whatever the action started.
      evt.preventDefault();
      evt.stopPropagation();
      action.run();
    });
  }
  return el;
}

/**
 * Draw a set of dictionaries: the ones with an icon as a grid of picture tiles, the
 * rest as a single-column list below it.
 *
 * The split is Iconic's. A dictionary the user bothered to give an icon earns a
 * picture tile, and a vault with no icons degrades to a plain list rather than a
 * grid of identical blank squares.
 */
export function renderDictionaryTiles(
  app: App,
  container: HTMLElement,
  tiles: TileInfo[],
  action?: (info: TileInfo) => TileOptions["action"],
): void {
  const withIcon = tiles.filter((tile) => tile.icon !== null);
  const withoutIcon = tiles.filter((tile) => tile.icon === null);
  const options = (tile: TileInfo, flat: boolean): TileOptions => {
    const found = action?.(tile);
    return found ? { flat, action: found } : { flat };
  };
  if (withIcon.length > 0) {
    const grid = container.createDiv({ cls: "fsrs-vocabulary-tiles" });
    for (const tile of withIcon) renderDictionaryTile(app, grid, tile, options(tile, false));
  }
  if (withoutIcon.length > 0) {
    const list = container.createDiv({ cls: "fsrs-vocabulary-tile-list" });
    for (const tile of withoutIcon) renderDictionaryTile(app, list, tile, options(tile, true));
  }
}
