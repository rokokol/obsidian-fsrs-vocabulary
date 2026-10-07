import { Component, Modal, type App } from "obsidian";
import { gradeOf, previewDueDates, review, REVIEW_RATINGS, type ReviewRating } from "../model/srs";
import { isBlankCell } from "../model/word";
import { renderCellValue } from "../render/cellValue";
import { writeReview, type ReviewItem } from "../review/collect";
import type { ReviewPrefs } from "./prompts";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatInterval(now: Date, due: Date): string {
  const ms = due.getTime() - now.getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes).toString()}m`;
  const hours = Math.round(ms / 3600000);
  if (hours < 24) return `${hours.toString()}h`;
  return `${Math.round(ms / 86400000).toString()}d`;
}

/** Flashcard review session over a fixed list of items. */
export class ReviewModal extends Modal {
  private readonly items: ReviewItem[];
  private readonly prefs: ReviewPrefs;
  private readonly renderComponent = new Component();
  private index = 0;
  private revealed = false;
  /** Set while a grade is being written, to keep a second one from starting. */
  private grading = false;

  constructor(app: App, items: ReviewItem[], prefs: ReviewPrefs) {
    super(app);
    this.items = items;
    this.prefs = prefs;
  }

  override onOpen(): void {
    this.modalEl.addClass("fsrs-vocabulary-review-modal");
    if (this.prefs.keepQuestion) this.modalEl.addClass("is-joined");
    this.renderComponent.load();
    this.registerKeys();
    this.renderCard();
  }

  override onClose(): void {
    this.renderComponent.unload();
    this.contentEl.empty();
  }

  private registerKeys(): void {
    this.scope.register([], " ", (evt) => {
      // Space both reveals and advances practice cards, so without this a held
      // key would race through the session, discarding a card every other repeat.
      if (evt.repeat) return false;
      if (this.revealed) this.advanceUngraded();
      else this.reveal();
      return false;
    });
    (["1", "2", "3", "4"] as const).forEach((key, i) => {
      this.scope.register([], key, (evt) => {
        if (evt.repeat) return false;
        const rating = REVIEW_RATINGS[i];
        if (this.revealed && rating && this.currentItem()?.record === true) void this.grade(rating);
        return false;
      });
    });
  }

  private currentItem(): ReviewItem | undefined {
    return this.items[this.index];
  }

  /**
   * Columns of `item` that would actually render — blank cells show nothing. Asked
   * the same way a row is judged a card at all, so a cell of invisible characters is
   * not given a labelled row of its own with nothing in it.
   */
  private static filled(item: ReviewItem, columns: readonly string[]): string[] {
    return columns.filter((col) => !isBlankCell(item.fields[col] ?? ""));
  }

  /**
   * Render a set of columns. Answers are always labeled; a single-column question
   * renders bare, since a lone "word: ubiquitous" label would be noise.
   */
  private renderFields(
    container: HTMLElement,
    item: ReviewItem,
    columns: readonly string[],
    labelled: boolean,
  ): void {
    for (const col of ReviewModal.filled(item, columns)) {
      const value = item.fields[col] ?? "";
      const target = labelled
        ? container.createDiv({ cls: "fsrs-vocabulary-review-field" })
        : container;
      if (labelled) target.createDiv({ cls: "fsrs-vocabulary-review-field-name", text: col });
      const valueEl = labelled
        ? target.createDiv({ cls: "fsrs-vocabulary-review-field-value" })
        : target;
      renderCellValue(this.app, valueEl, value, item.file.path, this.renderComponent);
    }
  }

  private renderCard(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.revealed = false;

    const item = this.currentItem();
    if (!item) {
      this.renderDone();
      return;
    }

    contentEl.createDiv({
      cls: "fsrs-vocabulary-review-progress",
      text: `${(this.index + 1).toString()} / ${this.items.length.toString()}`,
    });

    const front = contentEl.createDiv({ cls: "fsrs-vocabulary-review-front" });
    // Decide from what will actually render: a two-column question whose second
    // cell is blank should look like a one-column question, not gain a label.
    const asked = ReviewModal.filled(item, item.frontColumns);
    this.renderFields(front, item, item.frontColumns, asked.length > 1);

    contentEl.createDiv({ cls: "fsrs-vocabulary-review-back" });
    const controls = contentEl.createDiv({ cls: "fsrs-vocabulary-review-controls" });

    // A card whose answer would render nothing — a question covering every column,
    // or a row with only blank answers — has nothing to hide, so skip the step.
    if (ReviewModal.filled(item, item.backColumns).length === 0) {
      this.reveal();
      return;
    }
    const showBtn = controls.createEl("button", {
      cls: "mod-cta",
      text: "Show answer",
    });
    showBtn.addEventListener("click", () => {
      this.reveal();
    });
  }

  private reveal(): void {
    const item = this.currentItem();
    if (!item || this.revealed) return;

    const back = this.contentEl.querySelector<HTMLElement>(".fsrs-vocabulary-review-back");
    const controls = this.contentEl.querySelector<HTMLElement>(".fsrs-vocabulary-review-controls");
    if (!back || !controls) return;
    this.revealed = true;

    this.renderFields(back, item, item.backColumns, true);
    // Two ways to show the answer. Joined (the default), the answer settles in
    // under the question, so the whole card is on screen at once — which is what
    // you want when the fields are parts of one entry rather than two sides of a
    // riddle. Otherwise the card turns over and the answer takes the question's
    // place. Either way a card with nothing to show keeps its question, since
    // flipping to an empty face would just blank the modal.
    if (!this.prefs.keepQuestion && ReviewModal.filled(item, item.backColumns).length > 0) {
      this.contentEl.querySelector<HTMLElement>(".fsrs-vocabulary-review-front")?.remove();
    }
    controls.empty();

    // Practice runs do not touch the schedule, so grading would be theatre: the
    // intervals on the rating buttons describe a card state that is never saved.
    if (!item.record) {
      const next = controls.createEl("button", { cls: "mod-cta", text: "Next" });
      next.addEventListener("click", () => {
        this.advanceUngraded();
      });
      return;
    }

    const now = new Date();
    const preview = previewDueDates(item.card, this.prefs.retention, now);
    for (const rating of REVIEW_RATINGS) {
      const btn = controls.createEl("button", {
        cls: `fsrs-vocabulary-rate fsrs-vocabulary-rate-${rating}`,
      });
      btn.createSpan({ text: capitalize(rating) });
      btn.createSpan({
        cls: "fsrs-vocabulary-rate-hint",
        text: formatInterval(now, preview[rating]),
      });
      btn.addEventListener("click", () => {
        void this.grade(rating);
      });
    }
  }

  /** Move on without recording anything (practice runs). */
  private advanceUngraded(): void {
    if (this.currentItem()?.record !== false) return;
    this.index += 1;
    this.renderCard();
  }

  /**
   * Grade the current card and move on. The reentrancy flag matters because the
   * index only advances after the write resolves: without it a repeated key or a
   * double-click starts a second grade on the same card, writing it twice and
   * skipping the next one.
   */
  private async grade(rating: ReviewRating): Promise<void> {
    const item = this.currentItem();
    if (!item?.record || this.grading) return;
    this.grading = true;
    try {
      const now = new Date();
      const next = review(item.card, rating, this.prefs.retention, now);
      if (await writeReview(this.app, item, next)) {
        this.prefs.logReview({
          c: item.cardId,
          t: now.getTime(),
          r: gradeOf(rating),
          s: item.card.state,
        });
      }
      this.index += 1;
      this.renderCard();
    } finally {
      this.grading = false;
    }
  }

  private renderDone(): void {
    const { contentEl } = this;
    contentEl.createDiv({
      cls: "fsrs-vocabulary-review-done",
      text: `Review complete — ${this.items.length.toString()} cards.`,
    });
    const controls = contentEl.createDiv({ cls: "fsrs-vocabulary-review-controls" });
    const close = controls.createEl("button", { cls: "mod-cta", text: "Close" });
    close.addEventListener("click", () => {
      this.close();
    });
  }
}
