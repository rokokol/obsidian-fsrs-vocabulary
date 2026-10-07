/** Shared entry points for the add/import/review flows (commands and view). */

import { Notice, type App, type TFile } from "obsidian";
import { appendWord, appendWords, contentColumnsOf } from "../commands/dictionaryCommands";
import { contentColumns } from "../model/dictionary";
import { emptyConfig, type ReviewOrder } from "../model/dictionaryConfig";
import type { ReviewLogEntry } from "../model/history";
import type { Scheduling } from "../model/srs";
import { readDictionary, type DictionaryDoc } from "../obsidian/dictionaryFile";
import { gatherCards, type GatherResult, type ResolveOptions } from "../review/collect";
import { applySlice, quickOptions, shuffle, type ReviewSlice } from "../review/options";
import { AddWordModal } from "./addWordModal";
import { ImportWordsModal } from "./importWordsModal";
import { ReviewModal } from "./reviewModal";
import { ReviewOptionsModal } from "./reviewOptionsModal";

/** Open the add-word prompt for `doc`; the word is appended on submit. */
export function promptAddWord(
  app: App,
  file: TFile,
  doc: DictionaryDoc,
  fallbackColumns: string[],
): void {
  const columns = contentColumnsOf(doc, fallbackColumns);
  new AddWordModal(app, columns, file.path, (values) => {
    void appendWord(app, file, values);
  }).open();
}

/** Open the import prompt for `doc`; complete rows are appended on submit. */
export function promptImportWords(
  app: App,
  file: TFile,
  doc: DictionaryDoc,
  fallbackColumns: string[],
): void {
  const columns = contentColumnsOf(doc, fallbackColumns);
  new ImportWordsModal(app, columns, (rows) => {
    void appendWords(app, file, rows);
  }).open();
}

/** Session behaviour that comes from the plugin settings, not the dictionary. */
export interface ReviewPrefs {
  /** FSRS target retention and weights. */
  scheduling: Scheduling;
  /** Whether the answer joins the question on screen instead of replacing it. */
  keepQuestion: boolean;
  /** Called once per grade that reached the disk, for the review log. */
  logReview: (entry: ReviewLogEntry) => void;
}

export interface ReviewSession {
  prefs: ReviewPrefs;
  /** How each dictionary in the session is reviewed. */
  resolve: ResolveOptions;
  /**
   * Forces the session order. Null lets the dictionaries decide (the quick path);
   * the options dialog sets it, because the user chose it explicitly there.
   */
  order: ReviewOrder | null;
}

/** Why a session collected nothing — the pool and filter that were asked for. */
function emptyReason(gathered: GatherResult): string {
  if (gathered.filtered) return "No cards match that filter.";
  if (gathered.pool === "due") return "No cards due for review.";
  return "Nothing to review — no words found.";
}

/**
 * Collect and run a review session, or say why it came up empty. Shuffling
 * happens here rather than per dictionary, so a vault-wide session interleaves
 * them instead of shuffling each in place.
 */
export async function startReviewSession(
  app: App,
  files: TFile[],
  session: ReviewSession,
): Promise<void> {
  const gathered = await gatherCards(app, files, new Date(), session.resolve);
  if (gathered.items.length === 0) {
    new Notice(emptyReason(gathered));
    return;
  }
  const order = session.order ?? gathered.order;
  const items = order === "shuffled" ? shuffle(gathered.items) : gathered.items;
  new ReviewModal(app, items, session.prefs).open();
}

/**
 * The quick Review path: every dictionary runs its own first preset (or the
 * default layout), with no dialog in between.
 */
export async function quickReview(app: App, files: TFile[], prefs: ReviewPrefs): Promise<void> {
  await startReviewSession(app, files, {
    prefs,
    order: null,
    resolve: (doc, headers) => quickOptions(doc.frontmatter.config, headers),
  });
}

/** Review one slice of the cards — what clicking a stats tile does. */
export async function reviewSlice(
  app: App,
  files: TFile[],
  prefs: ReviewPrefs,
  slice: ReviewSlice,
): Promise<void> {
  await startReviewSession(app, files, {
    prefs,
    order: null,
    resolve: (doc, headers) => applySlice(quickOptions(doc.frontmatter.config, headers), slice),
  });
}

/**
 * Ask how to review, then start. The dialog edits one dictionary's layout, so a
 * multi-dictionary session only offers the session-wide choices and leaves every
 * dictionary its own columns.
 */
export async function promptReview(app: App, files: TFile[], prefs: ReviewPrefs): Promise<void> {
  const single = files.length === 1 ? files[0] : undefined;
  const doc = single ? await readDictionary(app, single) : null;
  const headers = doc?.table?.headers ?? [];
  const config = doc?.frontmatter.config ?? emptyConfig();

  new ReviewOptionsModal(
    app,
    single ?? null,
    config,
    contentColumns(headers),
    headers,
    (choice) => {
      void startReviewSession(app, files, {
        prefs,
        order: choice.order,
        resolve: (dictionary, dictionaryHeaders) => {
          // Without a shared column set, each dictionary keeps its own layout and
          // only the session-wide choices are applied on top. An order the user
          // did not pick likewise stays the dictionary's own.
          const base = quickOptions(dictionary.frontmatter.config, dictionaryHeaders);
          const columns = choice.columns;
          return {
            frontColumns: columns ? columns.front : base.frontColumns,
            backColumns: columns ? columns.back : base.backColumns,
            pool: choice.pool,
            order: choice.order ?? base.order,
            record: choice.record,
          };
        },
      });
    },
  ).open();
}
