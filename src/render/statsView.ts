import type { App, TFile } from "obsidian";
import { State } from "ts-fsrs";
import { tableCards } from "../model/cards";
import type { IconicIcon } from "../model/iconic";
import { isDue } from "../model/srs";
import { readDictionary } from "../obsidian/dictionaryFile";
import { quickOptions } from "../review/options";
import { renderDictionaryTiles } from "./dictionaryTile";

export interface Stats {
  total: number;
  fresh: number;
  learning: number;
  review: number;
  relearning: number;
  due: number;
}

function emptyStats(): Stats {
  return { total: 0, fresh: 0, learning: 0, review: 0, relearning: 0, due: 0 };
}

/**
 * Stats for a single dictionary's rows. `front` is the columns the dictionary's
 * cards ask with — the same list the session behind a tile uses, so the tile's
 * number and the session it opens count the same rows.
 */
export function statsForRows(
  rows: Record<string, string>[],
  front: readonly string[],
  now: Date,
): Stats {
  const stats = emptyStats();
  for (const card of tableCards(rows, front, now)) {
    stats.total += 1;
    if (isDue(card, now)) stats.due += 1;
    switch (card.state) {
      case State.New:
        stats.fresh += 1;
        break;
      case State.Learning:
        stats.learning += 1;
        break;
      case State.Review:
        stats.review += 1;
        break;
      case State.Relearning:
        stats.relearning += 1;
        break;
    }
  }
  return stats;
}

/** Stats for one dictionary, or null when the note has no words table. */
export async function statsForFile(app: App, file: TFile, now: Date): Promise<Stats | null> {
  const doc = await readDictionary(app, file);
  if (!doc?.table) return null;
  const front = quickOptions(doc.frontmatter.config, doc.table.headers).frontColumns;
  return statsForRows(doc.table.rows, front, now);
}

/** What a tile does when clicked, keyed by the tile it belongs to. */
export type StatKind = "total" | "due" | "new" | "learning" | "review";
export type StatActions = Partial<Record<StatKind, () => void>>;

function statCell(
  container: HTMLElement,
  label: string,
  value: number,
  kind: StatKind,
  onClick?: () => void,
): void {
  const cls = `dictionary-notes-stat is-${kind}`;
  // A plain div until it does something: a button that only looks clickable is
  // worse than a number. The label spells out both halves of the tile, since a
  // screen reader would otherwise read the value and the word as one run-on.
  const cell = onClick
    ? container.createEl("button", {
        cls: `${cls} is-clickable`,
        attr: { "aria-label": `Review ${label.toLowerCase()} cards (${value})` },
      })
    : container.createDiv({ cls });
  cell.createDiv({ cls: "dictionary-notes-stat-value", text: value.toString() });
  cell.createDiv({ cls: "dictionary-notes-stat-label", text: label });
  if (onClick) cell.addEventListener("click", onClick);
}

/** Render a stats grid into `el` (does not clear `el`). */
export function renderStatsGrid(el: HTMLElement, stats: Stats, actions: StatActions = {}): void {
  const grid = el.createDiv({ cls: "dictionary-notes-stats" });
  statCell(grid, "Total", stats.total, "total", actions.total);
  statCell(grid, "Due", stats.due, "due", actions.due);
  statCell(grid, "New", stats.fresh, "new", actions.new);
  statCell(grid, "Learning", stats.learning + stats.relearning, "learning", actions.learning);
  statCell(grid, "Review", stats.review, "review", actions.review);
}

/** What a stats block needs to know about the dictionaries it covers. */
export interface StatsBlockContext {
  /** Iconic icons by path, empty when the integration is off. */
  icons: Map<string, IconicIcon>;
  muted: (file: TFile) => boolean;
  /** Scopes that matched no dictionary, named so a typo is visible. */
  missing?: string[];
}

/**
 * Render an `dictionary-notes-stats` code block: a tile per dictionary it covers, then
 * the totals across them.
 *
 * A tile rather than a bare link, and one for a single dictionary too. The block is
 * usually the only thing in the note pointing at the dictionary, so it may as well
 * be the way in — and with an Iconic icon it is the same tile the shelf shows,
 * which makes a dictionary recognisable in both places.
 *
 * Counting happens first and drawing second, with no `await` between clearing `el`
 * and filling it. Two renders can share an element — a block redrawn while its
 * first pass is still reading dictionaries off disk — and clearing up front would
 * put both `empty()` calls before either set of tiles: each would wipe an element
 * neither had written to yet, and both would then append, leaving the block with
 * two of everything. Drawing in one synchronous run instead means the later render
 * simply replaces the earlier one, whichever order they finish in.
 */
export async function renderStats(
  app: App,
  files: TFile[],
  el: HTMLElement,
  actions: StatActions = {},
  context?: StatsBlockContext,
): Promise<void> {
  const missing = context?.missing ?? [];
  const now = new Date();
  // Keyed by path, and the tiles are drawn from the same map: a caller that passed
  // the same dictionary twice gets one tile, not two tiles over one set of numbers.
  const perFile = new Map<string, { file: TFile; stats: Stats | null }>();
  for (const file of files) {
    if (perFile.has(file.path)) continue;
    perFile.set(file.path, { file, stats: await statsForFile(app, file, now) });
  }
  el.empty();
  for (const scope of missing) {
    el.createDiv({
      cls: "dictionary-notes-stats-empty",
      text: `No dictionary found for "${scope}".`,
    });
  }
  if (perFile.size === 0) {
    if (missing.length === 0) {
      el.createDiv({ cls: "dictionary-notes-stats-empty", text: "No dictionary found for stats." });
    }
    return;
  }
  renderDictionaryTiles(
    app,
    el,
    [...perFile.values()].map(({ file, stats }) => ({
      file,
      icon: context?.icons.get(file.path) ?? null,
      stats,
      muted: context?.muted(file) ?? false,
    })),
  );
  renderStatsGrid(el, sumStats([...perFile.values()].map((entry) => entry.stats)), actions);
}

/** Add up what was already counted per dictionary. */
function sumStats(all: (Stats | null)[]): Stats {
  const total = emptyStats();
  for (const stats of all) {
    if (!stats) continue;
    for (const key of Object.keys(total) as (keyof Stats)[]) total[key] += stats[key];
  }
  return total;
}
