import {
  type MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  Plugin,
  setIcon,
  TFile,
  TFolder,
  type ViewState,
  WorkspaceLeaf,
} from "obsidian";
import { State } from "ts-fsrs";
import { createDictionaryNote } from "./commands/dictionaryCommands";
import { rescheduleAll } from "./commands/reschedule";
import { tableCards } from "./model/cards";
import { countedDictionaries, type DictionaryConfig } from "./model/dictionaryConfig";
import type { ReviewLogEntry } from "./model/history";
import type { IconicIcon } from "./model/iconic";
import { DictionaryCache } from "./obsidian/cache";
import { deviceId, devicePlatform } from "./obsidian/device";
import {
  dictionaryConfig,
  isDictionaryFile,
  readDictionary,
  updateDictionaryConfig,
} from "./obsidian/dictionaryFile";
import { ReviewHistory } from "./obsidian/history";
import { forgetIconicIcons, readIconicIcons } from "./obsidian/iconic";
import { parseStatsBlock, parseWikilink } from "./render/blocks";
import { renderDictionaryEmbeds } from "./render/dictionaryEmbed";
import { renderDictionary, type ReviewMode } from "./render/dictionaryView";
import { renderStats, type StatActions } from "./render/statsView";
import { DueTracker } from "./review/dueTracker";
import { quickOptions, type ReviewSlice } from "./review/options";
import { DEFAULT_SETTINGS, migrateSettings, type FsrsVocabularySettings } from "./settings";
import { ConfirmModal } from "./ui/confirmModal";
import {
  promptAddWord,
  promptImportWords,
  promptReview,
  quickReview,
  reviewSlice,
  type ReviewPrefs,
} from "./ui/prompts";
import { FsrsVocabularySettingTab } from "./ui/settingsTab";
import { errorMessage, plural } from "./util";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./view/dashboardView";
import { DICTIONARY_VIEW_TYPE, DictionaryEditorView } from "./view/dictionaryEditorView";
import { DictionaryTilesView, TILES_VIEW_TYPE } from "./view/tilesView";

/** "1 dictionary" / "4 dictionaries" — the one plural in the plugin that is irregular. */
function dictionaries(count: number): string {
  return `${count.toString()} ${count === 1 ? "dictionary" : "dictionaries"}`;
}

/** What an `fsrs-vocabulary-stats` block resolved to: dictionaries, and scopes that found none. */
interface StatsBlockFiles {
  files: TFile[];
  missing: string[];
}

export default class FsrsVocabularyPlugin extends Plugin {
  override settings: FsrsVocabularySettings = DEFAULT_SETTINGS;
  readonly cache = new DictionaryCache(this.app);
  /** Paths the user explicitly asked to keep open as markdown (skip auto-swap). */
  private readonly forceMarkdown = new Set<string>();
  /** Set while our `setViewState` wrapper is installed; see `interceptOpens`. */
  private intercepting = false;
  /** Watches the status bar so we can hide it only while it's empty. */
  private statusBarObserver: MutationObserver | null = null;
  private readonly dueTracker = new DueTracker(
    this.app,
    () => this.cache.files(),
    () => {
      this.dueChanged();
    },
    (file) => this.readDueTimestamps(file),
  );
  private statusBarEl: HTMLElement | null = null;
  /** Handle of the repeating reminder, so a settings change can replace it. */
  private reminderTimer: number | null = null;
  /** Period the running reminder was armed with; 0 = not running. */
  private reminderPeriod = 0;
  /** The start-up notice waits for the first count instead of guessing at zero. */
  private startupReminderPending = false;
  /** Whether the due cache is being maintained (mirrors `remindersEnabled`). */
  private tracking = false;
  /**
   * Whether the metadata cache has said it read everything. Only the first
   * `resolved` is worth forcing a pass for; before it, an index that found no
   * dictionaries means nothing, and after it, it means the vault has none.
   */
  private settled = false;
  /** How to redraw each `fsrs-vocabulary-stats` block and dictionary embed on screen. */
  private readonly statsBlocks = new Set<() => void>();
  /** The review log; set first thing in `onload`, before any session can start. */
  private history: ReviewHistory | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.history = new ReviewHistory(
      this.app.vault.adapter,
      this.pluginDir(),
      devicePlatform(),
      deviceId(this.app),
    );
    this.addSettingTab(new FsrsVocabularySettingTab(this.app, this));

    this.registerView(DICTIONARY_VIEW_TYPE, (leaf) => new DictionaryEditorView(leaf, this));
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
    this.registerView(TILES_VIEW_TYPE, (leaf) => new DictionaryTilesView(leaf, this));

    this.applyStatusBar();
    this.applyReminderTimer();
    // Cards fall due purely from time passing, so recount on a slow tick too.
    // The same tick drops cached dictionaries whose file went away without an
    // event we saw, which would otherwise inflate the count all session.
    this.registerInterval(
      window.setInterval(
        () => {
          this.dueTracker.prune();
          this.updateDueCounter();
        },
        5 * 60 * 1000,
      ),
    );

    this.interceptOpens();

    this.app.workspace.onLayoutReady(() => {
      // Unconditional: this runs once, and it is the first moment there are panes
      // to sweep at all. An earlier pass may have read a perfectly good index into
      // a workspace that did not exist yet.
      this.indexVault(true);
      this.updateChrome();
      this.startupReminderPending = this.settings.remindersEnabled && this.settings.remindOnStartup;
      this.applyTracking();
    });
    // `onLayoutReady` says the panes are up, not that the notes have been read:
    // on a cold start Obsidian indexes frontmatter after it draws the workspace,
    // so detection there sees no `fsrs-vocabulary` property anywhere and the index
    // comes back empty — the dashboard says there are no dictionaries and a
    // restored dictionary tab stays plain markdown until the user reopens it.
    // `resolved` is the cache announcing it has read everything, so index again,
    // and force that first one through: it is the pass whose answer can finally be
    // believed. Registered out here rather than inside the wait above, because it
    // can land before the layout is ready — and a handler registered from within
    // that callback would miss it, leaving the next `resolved` to wait on the user
    // editing a file.
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        const first = !this.settled;
        this.settled = true;
        this.indexVault(first);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.maybeSwap(leaf);
        this.updateChrome();
      }),
    );

    this.addRibbonIcon("layout-dashboard", "FSRS Vocabulary dashboard", () => {
      void this.openDashboard();
    });

    this.addRibbonIcon("book-a", "Open as dictionary", () => {
      const file = this.app.workspace.getActiveFile();
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (file && leaf && isDictionaryFile(this.app, file)) {
        void this.openAsDictionary(file, leaf);
      } else {
        new Notice("Active note is not an FSRS Vocabulary dictionary.");
      }
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      renderDictionary(
        el,
        ctx,
        (sourcePath, mode) => {
          void this.reviewByPath(sourcePath, mode);
        },
        this.settings.properties,
      );
    });

    this.registerMarkdownCodeBlockProcessor("fsrs-vocabulary-stats", (source, el, ctx) => {
      this.liveStats(ctx, el, () => this.statsFiles(source, ctx.sourcePath));
    });

    // An embed of a dictionary shows its stats instead of transcluding every word.
    this.registerMarkdownPostProcessor((el, ctx) => {
      renderDictionaryEmbeds(
        el,
        (target) => this.embeddedDictionary(target, ctx.sourcePath) !== null,
        (target, container) => {
          this.liveStats(ctx, container, () => {
            const file = this.embeddedDictionary(target, ctx.sourcePath);
            // The target resolved when the embed was drawn; if a redraw cannot find
            // it, it has been deleted or renamed, and saying so beats a stale card.
            return file ? { files: [file], missing: [] } : { files: [], missing: [target] };
          });
        },
      );
    });

    this.addCommand({
      id: "add-word",
      name: "Add word to dictionary",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isDictionaryFile(this.app, file)) return false;
        if (!checking) void this.promptAddWord(file);
        return true;
      },
    });

    this.addCommand({
      id: "new-dictionary",
      name: "New dictionary note",
      callback: () => {
        void this.createDictionary();
      },
    });

    this.addCommand({
      id: "reschedule",
      name: "Recompute schedule for current retention",
      callback: () => {
        this.promptReschedule();
      },
    });

    this.addCommand({
      id: "open-dashboard",
      name: "Open dictionary dashboard",
      callback: () => {
        void this.openDashboard();
      },
    });

    this.addCommand({
      id: "open-tiles",
      name: "Open dictionary tiles",
      callback: () => {
        void this.openTiles();
      },
    });

    this.addCommand({
      id: "review-due",
      name: "Review due cards",
      callback: () => {
        void this.startReview("quick");
      },
    });

    this.addCommand({
      id: "review-with-options",
      name: "Review with options…",
      callback: () => {
        void this.startReview("options");
      },
    });

    this.addCommand({
      id: "import-words",
      name: "Import words to dictionary",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isDictionaryFile(this.app, file)) return false;
        if (!checking) void this.promptImportWords(file);
        return true;
      },
    });

    this.addCommand({
      id: "open-as-dictionary",
      name: "Open as dictionary",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file ?? null;
        if (!view || !file || !isDictionaryFile(this.app, file)) return false;
        if (!checking) void this.openAsDictionary(file, view.leaf);
        return true;
      },
    });

    this.addCommand({
      id: "open-as-markdown",
      name: "Open dictionary as markdown",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(DictionaryEditorView);
        const file = view?.getFile() ?? null;
        if (!view || !file) return false;
        if (!checking) void this.openAsMarkdown(file, view.leaf);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle("New dictionary here")
              .setIcon("book-plus")
              .onClick(() => {
                void this.createDictionary(file);
              });
          });
          return;
        }
        if (!(file instanceof TFile) || !isDictionaryFile(this.app, file)) return;
        const inDictionaryView = leaf?.view instanceof DictionaryEditorView;
        menu.addItem((item) => {
          item
            .setTitle(inDictionaryView ? "Open as markdown" : "Open as dictionary")
            .setIcon("book-a")
            .onClick(() => {
              const target = leaf ?? this.app.workspace.getMostRecentLeaf();
              if (!target) return;
              if (inDictionaryView) void this.openAsMarkdown(file, target);
              else void this.openAsDictionary(file, target);
            });
        });
        const muted = dictionaryConfig(this.app, file).mute;
        menu.addItem((item) => {
          item
            .setTitle(muted ? "Unmute reminders" : "Mute reminders")
            .setIcon(muted ? "bell" : "bell-off")
            .onClick(() => {
              void this.toggleMute(file);
            });
        });
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.cache.update(file);
        this.trackDue(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.trackDue(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.cache.remove(file.path);
        this.dueTracker.forget(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.dueTracker.forget(oldPath);
        if (file instanceof TFile) {
          this.cache.rename(oldPath, file);
          this.trackDue(file);
        }
      }),
    );
  }

  /**
   * Keep the due cache in step with one file. Re-reading is only worth it for
   * dictionaries; a note that just *stopped* being one still has to be dropped.
   * With reminders off nothing reads the count, so nothing is re-read either —
   * `remindersChanged` rebuilds the cache when they come back.
   */
  private trackDue(file: TFile): void {
    if (!this.tracking) return;
    if (isDictionaryFile(this.app, file)) this.dueTracker.invalidate(file.path);
    else this.dueTracker.forget(file.path);
  }

  private async promptAddWord(file: TFile): Promise<void> {
    const doc = await readDictionary(this.app, file);
    if (doc) promptAddWord(this.app, file, doc, this.settings.newDictionaryColumns);
  }

  private async promptImportWords(file: TFile): Promise<void> {
    const doc = await readDictionary(this.app, file);
    if (doc) promptImportWords(this.app, file, doc, this.settings.newDictionaryColumns);
  }

  /**
   * Reuse an open dashboard rather than stacking duplicates — and just reveal
   * it, since setting the view state again would tear the view down and rebuild
   * it, losing the scroll position.
   */
  private async openDashboard(): Promise<void> {
    await this.openSingleton(DASHBOARD_VIEW_TYPE);
  }

  private async openTiles(): Promise<void> {
    await this.openSingleton(TILES_VIEW_TYPE);
  }

  /** Reveal the one open view of this type, or make one. */
  private async openSingleton(type: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async createDictionary(parent?: TFolder): Promise<void> {
    const file = await createDictionaryNote(this.app, this.settings.newDictionaryColumns, parent);
    const leaf = this.app.workspace.getLeaf(true);
    // Opened as a dictionary outright rather than left to `interceptOpens`, which
    // asks the metadata cache — and the cache has not parsed a file this new. We
    // wrote it a moment ago, so there is nothing to detect.
    if (this.settings.defaultView === "dictionary") await this.openAsDictionary(file, leaf);
    else await leaf.openFile(file);
  }

  private async startReview(mode: ReviewMode): Promise<void> {
    if (this.settings.reviewScope === "note") {
      const active = this.activeDictionaryFile();
      if (!active) {
        new Notice("Open a dictionary note to review it.");
        return;
      }
      await this.reviewFiles([active], mode);
    } else {
      await this.reviewFiles(this.countedFiles(this.cache.files()), mode);
    }
  }

  /**
   * The dictionary note currently in focus. The custom dictionary view is not a
   * FileView, so `getActiveFile()` misses it — check that view explicitly first,
   * then fall back to the active markdown file.
   */
  private activeDictionaryFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(DictionaryEditorView);
    const fromView = view?.getFile() ?? null;
    if (fromView) return fromView;
    const active = this.app.workspace.getActiveFile();
    return active && isDictionaryFile(this.app, active) ? active : null;
  }

  /**
   * Hide Obsidian's status bar only while a dictionary view is active AND the
   * bar has no visible items. The custom view has no markdown editor, so core
   * status-bar items hide themselves and some themes paint the empty bar as a
   * stray floating pill. If another plugin still shows a status item, we leave
   * the bar alone. Re-run on layout/leaf changes and on status-bar mutations.
   */
  private updateChrome(): void {
    const active = this.app.workspace.getActiveViewOfType(DictionaryEditorView) !== null;
    const bar = document.body.querySelector<HTMLElement>(".status-bar");
    if (bar && this.statusBarObserver === null) {
      const observer = new MutationObserver(() => {
        this.updateChrome();
      });
      observer.observe(bar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
      this.statusBarObserver = observer;
    }
    const empty = bar !== null && FsrsVocabularyPlugin.isStatusBarEmpty(bar);
    document.body.toggleClass("fsrs-vocabulary-hide-status", active && empty);
  }

  /** True when every status-bar item is hidden (computed display none). */
  private static isStatusBarEmpty(bar: HTMLElement): boolean {
    return Array.from(bar.children).every((el) => getComputedStyle(el).display === "none");
  }

  /**
   * Due timestamps of one dictionary, for the tracker. The rows counted are the ones
   * its quick review would actually collect, so the number a reminder shows matches
   * the session that reminder opens.
   */
  private async readDueTimestamps(file: TFile): Promise<number[] | null> {
    const doc = await readDictionary(this.app, file);
    if (!doc?.table || doc.frontmatter.config.mute) return null;
    const front = quickOptions(doc.frontmatter.config, doc.table.headers).frontColumns;
    if (front.length === 0) return null;
    return tableCards(doc.table.rows, front, new Date()).map((card) => card.due.getTime());
  }

  /** Re-apply the reminder settings; called by the settings tab on every change. */
  remindersChanged(): void {
    this.applyStatusBar();
    this.applyReminderTimer();
    this.applyTracking();
    this.updateDueCounter();
  }

  /**
   * Start tracking due cards, once. Nothing reads the count while reminders are
   * off and `trackDue` stops maintaining it, so the cache has to be rebuilt when
   * they come back on — but only then: rebuilding on every reminder setting
   * change would blank the counter for two seconds and re-read the whole vault.
   */
  private applyTracking(): void {
    if (this.tracking === this.settings.remindersEnabled) return;
    this.tracking = this.settings.remindersEnabled;
    if (this.tracking) this.dueTracker.invalidateAll();
  }

  /**
   * Bring the status-bar counter into line with the settings. The element is
   * created once and then only hidden: `addStatusBarItem` registers a cleanup
   * per element, so making a new one on every toggle would pile them up. It
   * starts hidden because the first count is a couple of seconds away, and a
   * visible empty item would keep `updateChrome` from hiding an empty bar.
   */
  private applyStatusBar(): void {
    if (this.statusBarEl || !this.statusBarWanted()) return;
    const el = this.addStatusBarItem();
    el.addClass("fsrs-vocabulary-status", "mod-clickable");
    el.hide();
    el.addEventListener("click", () => {
      void this.reviewDue();
    });
    this.statusBarEl = el;
  }

  private statusBarWanted(): boolean {
    return this.settings.remindersEnabled && this.settings.statusBarCounter;
  }

  /**
   * (Re)arm the repeating reminder; zero minutes means start-up only.
   *
   * No clamping here: `remindEveryMinutes` is a finite integer in range by the
   * time it lands in the settings — `migrateSettings` clamps whatever was stored
   * and `parseRemindMinutes` clamps whatever was typed. Keep it that way; a
   * negative period would be clamped to no delay at all by the browser and fire a
   * notice on every tick.
   */
  private applyReminderTimer(): void {
    const minutes = this.settings.remindersEnabled ? this.settings.remindEveryMinutes : 0;
    const period = minutes * 60 * 1000;
    // Re-arming restarts the clock, so leave a timer that already runs at the
    // asked-for period alone — retyping the same interval or flipping an
    // unrelated reminder switch should not keep pushing the next reminder away.
    if (period === this.reminderPeriod) return;
    this.reminderPeriod = period;
    if (this.reminderTimer !== null) {
      window.clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
    if (period === 0) return;
    this.reminderTimer = this.registerInterval(
      window.setInterval(() => {
        this.remind();
      }, period),
    );
  }

  /** The tracker changed: repaint the counter, then greet on start-up. */
  private dueChanged(): void {
    this.updateDueCounter();
    // Only a finished pass knows the real count; an earlier notification (a
    // deleted file, say) would spend the start-up greeting on a count of zero.
    if (!this.startupReminderPending || !this.dueTracker.ready) return;
    this.startupReminderPending = false;
    this.remind();
  }

  /**
   * Paint the due count into the status bar. The element is *hidden* rather than
   * emptied at zero: `updateChrome` decides whether to hide the whole bar by
   * computed display, and a present-but-empty item would read as "not empty".
   */
  private updateDueCounter(): void {
    const el = this.statusBarEl;
    if (!el) return;
    const count = this.statusBarWanted() ? this.dueTracker.count() : 0;
    el.empty();
    if (count === 0) {
      el.hide();
    } else {
      setIcon(el.createSpan({ cls: "fsrs-vocabulary-status-icon" }), "book-a");
      el.createSpan({ text: count.toString() });
      el.setAttribute("aria-label", `Review ${FsrsVocabularyPlugin.cards(count)} due`);
      el.show();
    }
    this.updateChrome();
  }

  private static cards(count: number): string {
    return `${count} ${count === 1 ? "card" : "cards"}`;
  }

  /** Notice about waiting cards, with a link straight into a session. */
  private remind(): void {
    if (!this.settings.remindersEnabled) return;
    const count = this.dueTracker.count();
    if (count === 0) return;
    const notice = new Notice("", 10000);
    notice.messageEl.setText(`${FsrsVocabularyPlugin.cards(count)} due for review. `);
    const link = notice.messageEl.createEl("a", { text: "Review now", href: "#" });
    link.addEventListener("click", (evt) => {
      evt.preventDefault();
      notice.hide();
      void this.reviewDue();
    });
  }

  /**
   * The session a reminder promises: the cards it counted, and only those. The
   * quick path would run each dictionary's own preset instead, which may draw
   * from every word and includes dictionaries the user muted — so a notice
   * saying "3 cards due" could open a hundred-card session.
   */
  private async reviewDue(): Promise<void> {
    await reviewSlice(this.app, this.countedFiles(this.cache.files()), this.reviewPrefs(), {
      pool: "due",
    });
  }

  /** How review sessions started from here should behave. */
  reviewPrefs(): ReviewPrefs {
    return {
      retention: this.settings.fsrsRetention,
      keepQuestion: this.settings.keepQuestionOnReveal,
      logReview: (entry) => {
        this.logReview(entry);
      },
    };
  }

  /** The plugin's own folder, where the review logs live. */
  private pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  /**
   * Add a graded review to this device's log. A failed append is reported and
   * otherwise ignored: the grade itself is already on disk, and stopping the
   * session over a missing log line would cost more than the line is worth.
   */
  private logReview(entry: ReviewLogEntry): void {
    this.history?.append(entry).catch((err: unknown) => {
      console.error("[fsrs-vocabulary] could not log a review", err);
    });
  }

  /** Flip a dictionary's mute flag; muted dictionaries stay out of reminders. */
  async toggleMute(file: TFile): Promise<void> {
    let written: DictionaryConfig | null = null;
    try {
      // Flipped inside the write, off the frontmatter as parsed there: the
      // metadata cache lags a write by a beat, so deciding the new value out
      // here would drop the second of two quick clicks.
      written = await updateDictionaryConfig(this.app, file, (config) => {
        config.mute = !config.mute;
      });
    } catch (err) {
      new Notice(`Could not update ${file.basename}: ${errorMessage(err)}`);
      return;
    }
    if (!written) {
      new Notice("Could not update this note: its fsrs-vocabulary property is not a mapping.");
      return;
    }
    new Notice(written.mute ? `Muted ${file.basename}.` : `Unmuted ${file.basename}.`);
    this.dueTracker.invalidate(file.path);
    // No eager repaint: the views redraw from the metadata cache, which has not
    // re-parsed this write yet, so painting now would show the *old* bell and
    // only correct itself a moment later. Their `metadataCache.changed`
    // subscriptions fire once the write lands, which is the right moment.
  }

  /**
   * Open dictionaries in the dictionary view by rewriting the request, not by
   * correcting it afterwards.
   *
   * Swapping after the fact — the obvious approach, and the one this used to
   * take — puts a markdown view on the leaf first. Obsidian records that view in
   * the leaf's navigation history, so Back returned to the raw note of the file
   * you were already looking at, whereupon the swap ran again and recorded it
   * again: Back never got out of the file, and every bounce re-rendered the whole
   * note. Rewriting the state before the leaf acts on it means the markdown view
   * is never built, so there is nothing to flash and nothing to record.
   *
   * The patch is on the prototype, so it is global; it is removed on unload, and
   * left alone if someone patched on top of it (theirs would be lost otherwise).
   * `intercepting` makes the wrapper inert in the meantime.
   */
  private interceptOpens(): void {
    const proto = WorkspaceLeaf.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- held unbound on purpose: it is called back with the leaf as `this`, and put back on the prototype on unload
    const original = proto.setViewState;
    const rewrite = (viewState: ViewState): ViewState =>
      this.dictionaryViewState(viewState) ?? viewState;
    const patched = function (
      this: WorkspaceLeaf,
      viewState: ViewState,
      eState?: unknown,
    ): Promise<void> {
      return original.call(this, rewrite(viewState), eState);
    };
    proto.setViewState = patched;
    this.intercepting = true;
    this.register(() => {
      this.intercepting = false;
      if (proto.setViewState === patched) proto.setViewState = original;
    });
  }

  /** The dictionary-view state a markdown request should become, if any. */
  private dictionaryViewState(viewState: ViewState): ViewState | null {
    if (!this.intercepting || this.settings.defaultView !== "dictionary") return null;
    if (viewState.type !== "markdown") return null;
    const path: unknown = viewState.state?.["file"];
    if (typeof path !== "string" || this.forceMarkdown.has(path)) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !isDictionaryFile(this.app, file)) return null;
    // Only the file survives: `mode`, `source` and the rest describe the markdown
    // editor, and the dictionary view would store them straight back into its own
    // state, where the next markdown open would read them as stale.
    return { ...viewState, type: DICTIONARY_VIEW_TYPE, state: { file: path } };
  }

  /**
   * Find every dictionary in the vault and let the rest of the plugin catch up.
   *
   * Run at load and again when the metadata cache reports it has resolved, because
   * the load pass can legitimately find nothing: detection reads frontmatter, and
   * on a cold start there is none to read yet.
   *
   * Two passes are `force`d, because the work needs two things that arrive
   * independently — an index worth believing, and a workspace to show it in. The
   * first `resolved` brings the first; `onLayoutReady` brings the second, and it
   * cannot be skipped just because the index has stopped moving: a `resolved` that
   * landed before the panes existed swept a workspace of no leaves.
   *
   * Neither pass may lean on the rescan reporting a change, because "nothing
   * changed" is not evidence of anything here. The per-file `changed` handler
   * maintains the very set the rescan diffs against, so a startup that reparsed the
   * dictionaries has already filled it in, and the rescan finds its own work —
   * reporting no change while every view on screen still shows the empty vault it
   * drew at layout time.
   *
   * After those two, no change means no work. A `resolved` fires for each later
   * batch of edits, and repainting views the user is working in — or re-reading
   * every dictionary for the due count — on each one is not free. Both forced
   * passes land within seconds of a normal start; after a mid-session enable the
   * `resolved` one waits for whatever the user edits next, since the cache resolved
   * long before this instance existed. That same coupling to `changed` is what
   * makes this safe: when the user types the `fsrs-vocabulary` property by hand,
   * `changed` folds it in first, so the rescan reports nothing and this returns
   * before the sweep — which is what keeps the swap off a cursor still sitting in
   * the frontmatter block.
   */
  private indexVault(force: boolean): void {
    const changed = this.cache.rebuild();
    if (!force && !changed) return;
    // A restored tab is a markdown view of a note nobody yet knew was a
    // dictionary; now that we know, it can become one without being reopened.
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      this.maybeSwap(leaf, false);
    });
    // Everything that lists dictionaries drew whatever was known at the time,
    // which may have been nothing at all. `refreshRendered` covers the dictionary
    // views, the dashboard and every note being read — a `vault`-scoped stats block
    // among them — and deliberately skips the shelf, which is what the second call
    // is for.
    this.refreshRendered();
    this.refreshIconic();
    // Reminders count from a cache seeded by this list, so it was counting a
    // vault with no dictionaries in it.
    if (this.settings.remindersEnabled) this.dueTracker.invalidateAll();
  }

  /**
   * Swap a leaf that is *already* showing a dictionary as markdown — a restored
   * workspace at load, or a note the user has just given the `fsrs-vocabulary`
   * property to. Ordinary opens never reach this: `interceptOpens` catches them
   * before a markdown view is ever built.
   *
   * Deliberately tied to focus changing rather than to the note changing: a note
   * becomes a dictionary the moment the property is typed, and swapping then would
   * pull the editor out from under a cursor still inside the frontmatter block.
   * Leaving on the leaf and coming back is a clear enough signal.
   *
   * `indexVault` sweeps every leaf without waiting for focus, and on its ordinary
   * diff-gated passes that cannot catch a property just typed: `changed` folds the
   * note in first, so the rescan reports nothing moved and the sweep is never
   * reached. Its two forced passes are the exception, and they are honestly an
   * exception — at startup nobody is mid-frontmatter, but a plugin enabled
   * mid-session takes its first `resolved` from whatever the user edits next, which
   * could be that very property. Once per enable, and no worse than a view swap.
   *
   * `focus` is false for the sweep over every restored leaf: taking focus is right
   * when the user just moved to the leaf being swapped, and wrong when the plugin
   * is catching up on its own several leaves at a time, possibly seconds after the
   * user started typing somewhere else.
   */
  private maybeSwap(leaf: WorkspaceLeaf | null, focus = true): void {
    if (this.settings.defaultView !== "dictionary") return;
    if (!leaf) return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const file = view.file;
    if (!file || this.forceMarkdown.has(file.path)) return;
    if (!isDictionaryFile(this.app, file)) return;
    void leaf.setViewState({
      type: DICTIONARY_VIEW_TYPE,
      state: { file: file.path },
      active: focus,
    });
  }

  async openAsMarkdown(file: TFile, leaf: WorkspaceLeaf): Promise<void> {
    this.forceMarkdown.add(file.path);
    await leaf.setViewState({
      type: "markdown",
      state: { file: file.path, mode: "source" },
      active: true,
    });
  }

  async openAsDictionary(file: TFile, leaf: WorkspaceLeaf): Promise<void> {
    this.forceMarkdown.delete(file.path);
    await leaf.setViewState({
      type: DICTIONARY_VIEW_TYPE,
      state: { file: file.path },
      active: true,
    });
  }

  private filesFromPath(path: string): TFile[] {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? [file] : [];
  }

  /**
   * Files for an `fsrs-vocabulary-stats` block: an empty body means the current note,
   * and otherwise every line is a scope, in the order they were written.
   *
   * Deduplicated by path, since a block may name a dictionary that `vault` already
   * brought in, and counting it twice would double its numbers in the total.
   */
  private statsFiles(source: string, sourcePath: string): StatsBlockFiles {
    const query = parseStatsBlock(source);
    if (query.scopes.length === 0) return { files: this.filesFromPath(sourcePath), missing: [] };
    const seen = new Set<string>();
    const files: TFile[] = [];
    const missing: string[] = [];
    for (const scope of query.scopes) {
      const found = this.scopeFiles(
        scope.text,
        sourcePath,
        scope.includeMuted ?? query.includeMuted,
      );
      // A scope that finds nothing is nearly always a typo in a link, and silently
      // counting three dictionaries where four were asked for is a wrong number
      // presented as a right one.
      if (found.length === 0) missing.push(scope.text);
      for (const file of found) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        files.push(file);
      }
    }
    return { files, missing };
  }

  /**
   * One scope of a stats block: `vault`/`all` for every dictionary, otherwise a
   * dictionary referenced by name, path or `[[wiki-link]]`.
   *
   * Muted dictionaries drop out of the vault scope — a muted dictionary is one the
   * user stepped away from, and counting it makes the vault total disagree with the
   * reminder that opens the session. A scope naming one dictionary always shows it:
   * pointing at a dictionary is asking for its numbers, muted or not.
   */
  private scopeFiles(scope: string, sourcePath: string, includeMuted: boolean | null): TFile[] {
    const lower = scope.toLowerCase();
    if (lower === "vault" || lower === "all") {
      return this.countedFiles(this.cache.files(), includeMuted);
    }
    const linkpath = parseWikilink(scope.replace(/^!/, ""))?.target ?? scope;
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return file && isDictionaryFile(this.app, file) ? [file] : [];
  }

  /**
   * Offer to recompute every stored schedule for the retention now set.
   *
   * Behind a confirmation because it rewrites the `srs` and `due` cells of every
   * dictionary in the vault — the user's own files — and because the number of cards
   * it would move is the useful thing to know before saying yes. Muted dictionaries
   * are included: a schedule is a schedule whether or not it is being reminded about.
   */
  private promptReschedule(): void {
    const files = this.cache.files();
    if (files.length === 0) {
      new Notice("No dictionaries to reschedule.");
      return;
    }
    const retention = this.settings.fsrsRetention;
    new ConfirmModal(
      this.app,
      `Recompute due dates in ${dictionaries(files.length)} for a target retention of ` +
        `${retention.toString()}? Only cards in the review state move; what the plugin ` +
        "knows about your memory is not changed.",
      "Recompute",
      () => {
        void this.runReschedule(files, retention);
      },
    ).open();
  }

  private async runReschedule(files: TFile[], retention: number): Promise<void> {
    const result = await rescheduleAll(this.app, files, retention);
    this.dueTracker.invalidateAll();
    this.refreshRendered();
    const failed =
      result.failed.length > 0 ? ` ${result.failed.length.toString()} could not be written.` : "";
    if (result.moved === 0) {
      new Notice(`Every schedule already matches a retention of ${retention.toString()}.${failed}`);
      return;
    }
    new Notice(
      `Moved ${result.moved.toString()} card${plural(result.moved)} in ` +
        `${dictionaries(result.files)}.${failed}`,
    );
  }

  /** The dictionary an embed points at, or null when it points elsewhere. */
  private embeddedDictionary(target: string, sourcePath: string): TFile | null {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
    return file && isDictionaryFile(this.app, file) ? file : null;
  }

  /**
   * The icons to draw dictionaries with: Iconic's, or none at all when the
   * integration is off — in which case its data file is never touched.
   */
  iconicIcons(): Promise<Map<string, IconicIcon>> {
    return this.settings.iconicIntegration
      ? readIconicIcons(this.app)
      : Promise.resolve(new Map<string, IconicIcon>());
  }

  /**
   * Draw a stats block, and keep it redrawable for as long as it is on screen.
   *
   * Which dictionaries a block covers is decided when it renders, so a block that
   * rendered before the vault was indexed says there are none — and nothing brings
   * it back, because a code block is only re-processed when its note is. Reading
   * view has `rerender`, and that is what `refreshRendered` used to lean on; Live
   * Preview has no equivalent, and `getMode` calls it `source`, so those blocks were
   * skipped entirely and the user was left reopening the note to see their own
   * dictionaries.
   *
   * So each block registers how to redraw itself and drops that when it goes away.
   * `scope` is re-read on every redraw rather than captured, because what a scope
   * resolves to is exactly what changes underneath these blocks.
   */
  private liveStats(
    ctx: MarkdownPostProcessorContext,
    el: HTMLElement,
    scope: () => StatsBlockFiles,
  ): void {
    const redraw = (): void => {
      this.renderStatsBlock(scope(), el).catch((err: unknown) => {
        // Nothing has been drawn yet when a read fails — the renderer holds off
        // touching `el` until it has every number — so without this the block
        // keeps the figures it drew last time, which look perfectly current. Said
        // in the block rather than a notice: a redraw covers every block at once,
        // and one unreadable dictionary should not raise a row of popups.
        el.empty();
        el.createDiv({
          cls: "fsrs-vocabulary-stats-empty is-error",
          text: `Could not read the dictionaries for this block: ${errorMessage(err)}`,
        });
      });
    };
    this.statsBlocks.add(redraw);
    // Tied to the element: Obsidian unloads the child when the block leaves the
    // document, which is the only reliable signal that it is gone. Without it the
    // set would grow for the session and redraw into detached elements.
    const child = new MarkdownRenderChild(el);
    child.register(() => this.statsBlocks.delete(redraw));
    ctx.addChild(child);
    redraw();
  }

  /** Redraw every stats block on screen, in whichever mode it is being shown. */
  private redrawStatsBlocks(): void {
    // Copied because nothing here promises the set holds still, not because
    // anything is known to move it: a redraw only reaches its first `await` before
    // returning, and the re-render that registers new blocks runs after this.
    for (const redraw of [...this.statsBlocks]) redraw();
  }

  /**
   * Draw a stats block. The Iconic icons are fetched here rather than inside the
   * renderer: the renderer is also the dashboard's, and only the block wants a tile
   * per dictionary with the icon the shelf would show.
   */
  private async renderStatsBlock(block: StatsBlockFiles, el: HTMLElement): Promise<void> {
    const icons = await this.iconicIcons();
    await renderStats(this.app, block.files, el, this.statActions(block.files), {
      icons,
      muted: (file) => dictionaryConfig(this.app, file).mute,
      missing: block.missing,
    });
  }

  /**
   * Narrow a vault-wide list to what counts. `includeMuted` overrides the
   * setting; null means the setting decides.
   */
  countedFiles(files: TFile[], includeMuted: boolean | null = null): TFile[] {
    return countedDictionaries(
      files,
      (file) => dictionaryConfig(this.app, file).mute,
      includeMuted ?? this.settings.statsIncludeMuted,
    );
  }

  /** Tile actions shared by the stats block and the dashboard. */
  statActions(files: TFile[]): StatActions {
    const slice = (slice: ReviewSlice) => () => {
      void reviewSlice(this.app, files, this.reviewPrefs(), slice);
    };
    return {
      total: slice({ pool: "all", record: false }),
      due: slice({ pool: "due" }),
      new: slice({ pool: "all", states: [State.New] }),
      learning: slice({ pool: "all", states: [State.Learning, State.Relearning] }),
      review: slice({ pool: "all", states: [State.Review] }),
    };
  }

  private async reviewByPath(sourcePath: string, mode: ReviewMode): Promise<void> {
    const [file] = this.filesFromPath(sourcePath);
    if (file) await this.reviewFiles([file], mode);
  }

  private async reviewFiles(files: TFile[], mode: ReviewMode): Promise<void> {
    const start = mode === "options" ? promptReview : quickReview;
    await start(this.app, files, this.reviewPrefs());
  }

  /** Re-render every open dictionary view (after a settings change). */
  refreshDictionaryViews(): void {
    this.app.workspace.getLeavesOfType(DICTIONARY_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof DictionaryEditorView) leaf.view.refresh();
    });
  }

  /**
   * Repaint everything that renders dictionary content. Some settings — which
   * properties to show, whether muted dictionaries count — change what the
   * dashboard totals and every `fsrs-vocabulary-stats` block mean, and neither
   * redraws on its own: the dashboard waits for a dictionary edit, and a block's
   * processor only runs again on a re-render.
   *
   * The re-render is blunt: it hits every note being read, not just the ones with
   * a dictionary in them, and so re-runs other plugins' post-processors too. There
   * is no cheap way to ask which notes contain a stats block, and what makes the
   * bluntness affordable is how seldom this runs: twice while the vault is being
   * indexed at load, then only on a settings toggle, a migration or a reschedule.
   * Leaves not being read are skipped, which is most of them — and stats blocks in
   * those leaves are covered instead by the redraw below, which is the only thing
   * that reaches Live Preview at all.
   */
  refreshRendered(): void {
    // Not the tiles view: it reads no setting these controls change, and its own
    // header action covers the one thing it can go stale on.
    this.refreshDictionaryViews();
    this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof DashboardView) leaf.view.redraw();
    });
    this.redrawStatsBlocks();
    // A block being read is redrawn twice — once above, once by its processor
    // running again here. The rerender is still needed for everything else a
    // post-processor draws (the properties table, the review buttons), and the
    // wasted half is a second read of every dictionary in the block's scope, then
    // thrown away with the element it drew into. Paid twice per start for a block
    // being read, and not as cheap as it sounds — the file contents are cached but
    // the parse and the card states are not. Still worth it over a branch: nobody
    // is waiting on the result, and it comes a file at a time.
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.getMode() === "preview") {
        view.previewMode.rerender(true);
      }
    });
  }

  /**
   * Repaint the two views that draw Iconic icons — the shelf and the dashboard.
   * Separate from `refreshRendered` because the Iconic switch changes what they
   * draw and nothing else on screen cares, and because the shelf is the one thing
   * `refreshRendered` leaves out; `indexVault` calls both for that reason.
   */
  refreshIconic(): void {
    this.app.workspace.getLeavesOfType(TILES_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof DictionaryTilesView) leaf.view.redraw();
    });
    this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof DashboardView) leaf.view.redraw();
    });
  }

  override onunload(): void {
    this.dueTracker.dispose();
    forgetIconicIcons();
    // The blocks' own cleanup runs when Obsidian unloads them, which for a note
    // still open never happens. This does not free the plugin — the render
    // children hold their own references until their notes are redrawn — but it
    // guarantees a disabled instance repaints nothing, and drops the set's hold on
    // elements that outlive it.
    this.statsBlocks.clear();
    this.statusBarObserver?.disconnect();
    this.statusBarObserver = null;
    // Obsidian removes the item itself; dropping the handle keeps a late
    // callback from painting into a detached element.
    this.statusBarEl = null;
    document.body.removeClass("fsrs-vocabulary-hide-status");
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<FsrsVocabularySettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...migrateSettings(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
