import { Menu, Modal, Notice, Setting, setIcon, type App, type TFile } from "obsidian";
import {
  makePresetDefault,
  removePreset,
  renamePreset,
  upsertPreset,
  type DictionaryConfig,
  type ReviewOrder,
  type ReviewPool,
  type ReviewPreset,
} from "../model/dictionaryConfig";
import { updateDictionaryConfig } from "../obsidian/dictionaryFile";
import {
  missingFromTable,
  optionsFromPreset,
  optionsToPreset,
  quickOptions,
  type ReviewOptions,
} from "../review/options";
import { errorMessage } from "../util";
import { ConfirmModal } from "./confirmModal";

/**
 * What the dialog hands back. `columns` is null in vault scope, where each
 * dictionary keeps its own layout because they do not share columns; the rest
 * applies to the whole session either way.
 */
export interface ReviewChoice {
  columns: { front: string[]; back: string[] } | null;
  pool: ReviewPool;
  /** Null when the user did not choose one — the dictionaries decide. */
  order: ReviewOrder | null;
  record: boolean;
}

/**
 * Pick how to review before starting. Reached from the caret on the Review
 * button; the button itself runs the first preset without asking.
 *
 * `columns` empty means vault scope: the field pickers are hidden, since the
 * dictionaries in the session do not share a set of columns.
 */
export class ReviewOptionsModal extends Modal {
  private readonly file: TFile | null;
  /** Content columns offered as question/answer fields; empty in vault scope. */
  private readonly columns: string[];
  /** The table's full header list, for reconciling presets against it. */
  private readonly headers: string[];
  private readonly onStart: (choice: ReviewChoice) => void;
  private config: DictionaryConfig;
  private front: string[];
  private back: string[];
  private pool: ReviewPool;
  private order: ReviewOrder;
  private record: boolean;
  /** Name of the preset the current selection came from, for save/rename. */
  private source: string | null = null;
  /**
   * Whether the user actually picked an order. Without this, opening the dialog
   * in vault scope and pressing Start would impose the seeded default on every
   * dictionary, overriding ones that ask to shuffle.
   */
  private orderChosen = false;
  private naming = false;
  /** Which control to refocus after a redraw: `side:column`, or a control name. */
  private focus: string | null = null;

  constructor(
    app: App,
    file: TFile | null,
    config: DictionaryConfig,
    columns: string[],
    headers: string[],
    onStart: (choice: ReviewChoice) => void,
  ) {
    super(app);
    this.file = file;
    this.config = config;
    this.columns = columns;
    this.headers = headers;
    this.onStart = onStart;

    const options = quickOptions(config, headers);
    this.front = [...options.frontColumns];
    this.back = [...options.backColumns];
    this.pool = options.pool;
    this.order = options.order;
    this.record = options.record;
  }

  override onOpen(): void {
    this.modalEl.addClass("fsrs-vocabulary-options-modal");
    // Open showing exactly what the quick button would have done — through the
    // same path a click takes, so a preset naming a column the table has since
    // lost is reported here too, not only when picked by hand.
    const first = this.config.presets[0];
    if (first) this.applyPreset(first, false);
    else this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Review options" });

    this.renderPresets(contentEl);
    if (this.columns.length > 0) {
      this.renderColumnPicker(contentEl, "Question", this.front, "front");
      this.renderColumnPicker(contentEl, "Answer", this.back, "back");
    }
    this.renderSessionSettings(contentEl);
    this.renderControls(contentEl);
  }

  private renderPresets(parent: HTMLElement): void {
    if (this.config.presets.length === 0) return;
    const section = parent.createDiv({ cls: "fsrs-vocabulary-options-section" });
    section.createDiv({ cls: "fsrs-vocabulary-options-label", text: "Presets" });
    const row = section.createDiv({ cls: "fsrs-vocabulary-chips" });

    this.config.presets.forEach((preset, index) => {
      // A wrapper, not a button: the kebab is interactive and must not nest.
      const chip = row.createDiv({ cls: "fsrs-vocabulary-chip is-preset" });
      if (preset.name === this.source) chip.addClass("is-active");
      const label = chip.createEl("button", {
        cls: "fsrs-vocabulary-chip-label",
        text: preset.name,
      });
      if (index === 0) {
        label.createSpan({ cls: "fsrs-vocabulary-chip-note", text: "quick" });
      }
      label.addEventListener("click", () => {
        this.applyPreset(preset);
      });
      const menuBtn = chip.createEl("button", {
        cls: "fsrs-vocabulary-chip-menu",
        attr: { "aria-label": `Options for ${preset.name}` },
      });
      setIcon(menuBtn, "more-vertical");
      menuBtn.addEventListener("click", (evt) => {
        this.showPresetMenu(evt, preset);
      });
    });
  }

  /**
   * Load a preset into the form, reporting anything the table no longer has.
   * `chosen` is false for the preset the dialog opens on: seeding the form is
   * not the user picking an order, and in vault scope an order nobody picked
   * must not be imposed on the other dictionaries.
   */
  private applyPreset(preset: ReviewPreset, chosen = true): void {
    const options = optionsFromPreset(preset, this.headers);
    this.front = [...options.frontColumns];
    this.back = [...options.backColumns];
    this.pool = options.pool;
    this.order = options.order;
    this.orderChosen = chosen;
    this.record = options.record;
    this.source = preset.name;

    const missing = missingFromTable(preset, this.headers);
    if (missing.length > 0) {
      new Notice(
        `"${preset.name}" names ${missing.length === 1 ? "a column" : "columns"} this dictionary ` +
          `no longer has: ${missing.join(", ")}. Reviewing without ${
            missing.length === 1 ? "it" : "them"
          }.`,
      );
    }
    this.render();
  }

  private showPresetMenu(evt: MouseEvent, preset: ReviewPreset): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Make quick preset")
        .setIcon("play")
        .setDisabled(this.config.presets[0]?.name === preset.name)
        .onClick(() => {
          void this.mutate((config) => {
            makePresetDefault(config, preset.name);
          });
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Rename…")
        .setIcon("pencil")
        .onClick(() => {
          this.promptRename(preset);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => {
          new ConfirmModal(this.app, `Delete preset "${preset.name}"?`, "Delete", () => {
            if (this.source === preset.name) this.source = null;
            void this.mutate((config) => {
              removePreset(config, preset.name);
            });
          }).open();
        }),
    );
    menu.showAtMouseEvent(evt);
  }

  private promptRename(preset: ReviewPreset): void {
    new NamePromptModal(this.app, "Rename preset", preset.name, (name) => {
      if (name === preset.name) return;
      const clash = this.config.presets.some((p) => p.name === name);
      const apply = (): void => {
        if (this.source === preset.name) this.source = name;
        void this.mutate((config) => {
          renamePreset(config, preset.name, name);
        });
      };
      if (!clash) {
        apply();
        return;
      }
      // renamePreset absorbs the preset already under that name, and only the UI
      // can ask whether that is what the user meant.
      new ConfirmModal(
        this.app,
        `"${name}" already exists. Renaming replaces it — its settings are lost.`,
        "Replace",
        apply,
      ).open();
    }).open();
  }

  private renderColumnPicker(
    parent: HTMLElement,
    label: string,
    selected: string[],
    side: "front" | "back",
  ): void {
    const section = parent.createDiv({ cls: "fsrs-vocabulary-options-section" });
    section.createDiv({ cls: "fsrs-vocabulary-options-label", text: label });
    const row = section.createDiv({ cls: "fsrs-vocabulary-chips" });
    for (const column of this.columns) {
      const chip = row.createEl("button", { cls: "fsrs-vocabulary-chip", text: column });
      if (selected.includes(column)) chip.addClass("is-active");
      chip.addEventListener("click", () => {
        this.toggleColumn(side, column);
      });
      this.restoreFocus(`${side}:${column}`, chip);
    }
  }

  private toggleColumn(side: "front" | "back", column: string): void {
    const list = side === "front" ? this.front : this.back;
    const next = list.includes(column)
      ? list.filter((c) => c !== column)
      : // Keep the table's order, so the card reads the way the dictionary does.
        this.columns.filter((c) => c === column || list.includes(c));
    if (side === "front") {
      this.front = next;
      // A column cannot ask and answer at once — the card turns over, so it would
      // show the same value on both faces. Reconciliation enforces this for saved
      // presets; the pickers have to enforce it here.
      if (next.includes(column)) this.back = this.back.filter((c) => c !== column);
    } else {
      this.back = next;
      if (next.includes(column)) this.front = this.front.filter((c) => c !== column);
    }
    // Focus first: `edited` redraws, and the redraw is what places the cursor.
    this.focus = `${side}:${column}`;
    this.edited();
  }

  private renderSessionSettings(parent: HTMLElement): void {
    new Setting(parent)
      .setName("Cards")
      .setDesc("Only what is scheduled, or every word in the dictionary.")
      .addDropdown((dropdown) => {
        dropdown.addOption("due", "Due only");
        dropdown.addOption("all", "All cards");
        dropdown.setValue(this.pool);
        dropdown.onChange((value) => {
          this.pool = value === "all" ? "all" : "due";
          // Going through every card is practice, so stop touching the schedule
          // by default. The toggle below still overrides it.
          this.record = this.pool === "due";
          this.focus = "pool";
          this.edited();
        });
        this.restoreFocus("pool", dropdown.selectEl);
      });

    new Setting(parent).setName("Order").addDropdown((dropdown) => {
      dropdown.addOption("file", "Dictionary order");
      dropdown.addOption("shuffled", "Shuffled");
      dropdown.setValue(this.order);
      dropdown.onChange((value) => {
        this.order = value === "shuffled" ? "shuffled" : "file";
        this.orderChosen = true;
        this.focus = "order";
        this.edited();
      });
      this.restoreFocus("order", dropdown.selectEl);
    });

    new Setting(parent)
      .setName("Record progress")
      .setDesc("Off means grading does not reschedule anything.")
      .addToggle((toggle) => {
        // Seed before subscribing, and keep it that way: `setValue` fires the
        // change callback, and this one redraws — so subscribing first would
        // make every render re-enter itself until the stack gives out.
        toggle.setValue(this.record);
        toggle.onChange((value) => {
          this.record = value;
          this.focus = "record";
          this.edited();
        });
        this.restoreFocus("record", toggle.toggleEl);
      });
  }

  /**
   * Put the cursor back on the control that caused the redraw — once. Every edit
   * rebuilds the dialog, so without this a keyboard user is dropped to the top
   * of the document on each change. The target is consumed because a later
   * redraw has its own focus to place (the preset-name field), and a leftover
   * key would keep yanking the cursor back out of it.
   */
  private restoreFocus(key: string, el: HTMLElement): void {
    if (this.focus !== key) return;
    this.focus = null;
    window.setTimeout(() => {
      el.focus();
    }, 0);
  }

  /**
   * The form no longer matches the preset it was loaded from, so stop claiming
   * it does — the chip unhighlights and Save stops pre-filling that name, which
   * is what keeps a Replace from silently rewriting a preset the user only
   * loaded and tweaked. Both of those are drawn, so the redraw belongs here
   * rather than at each call site, where it kept being forgotten.
   */
  private edited(): void {
    this.source = null;
    this.render();
  }

  private renderControls(parent: HTMLElement): void {
    const empty = this.columns.length > 0 && this.front.length === 0;
    if (empty) {
      parent.createDiv({
        cls: "fsrs-vocabulary-options-warning",
        text: "Pick at least one question column.",
      });
    }

    if (this.naming) {
      this.renderNameRow(parent);
      return;
    }

    const controls = parent.createDiv({ cls: "modal-button-container" });
    if (this.file) {
      const save = controls.createEl("button", { text: "Save as preset…" });
      save.disabled = empty;
      save.addEventListener("click", () => {
        this.naming = true;
        this.render();
      });
    }
    const start = controls.createEl("button", { cls: "mod-cta", text: "Start" });
    start.disabled = empty;
    start.addEventListener("click", () => {
      this.start();
    });
  }

  private renderNameRow(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    const input = row.createEl("input", {
      type: "text",
      attr: { placeholder: "Preset name" },
    });
    input.value = this.source ?? "";
    const save = (): void => {
      const name = input.value.trim();
      if (name === "") {
        new Notice("A preset needs a name.");
        return;
      }
      this.savePreset(name);
    };
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") save();
      if (evt.key === "Escape") {
        this.naming = false;
        this.render();
      }
    });
    const confirm = row.createEl("button", { cls: "mod-cta", text: "Save" });
    confirm.addEventListener("click", save);
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.naming = false;
      this.render();
    });
    input.focus();
    input.select();
  }

  private savePreset(name: string): void {
    // Carry the keys the plugin does not model across an edit, or saving a
    // hand-annotated preset would quietly strip the annotations.
    const previous = this.config.presets.find((p) => p.name === name);
    const preset = optionsToPreset(name, this.choiceOptions(), previous);
    const write = (): void => {
      this.naming = false;
      this.source = name;
      void this.mutate((config) => {
        upsertPreset(config, preset);
      });
    };
    if (!previous) {
      write();
      return;
    }
    new ConfirmModal(this.app, `Replace the preset "${name}"?`, "Replace", write).open();
  }

  /** The current form as options, for saving. */
  private choiceOptions(): ReviewOptions {
    return {
      frontColumns: [...this.front],
      backColumns: [...this.back],
      pool: this.pool,
      order: this.order,
      record: this.record,
    };
  }

  /**
   * Apply a config change to the note, and mirror it in the form only once the
   * write succeeded — otherwise the dialog would show a preset list that is not
   * what is on disk.
   */
  private async mutate(change: (config: DictionaryConfig) => void): Promise<void> {
    const file = this.file;
    if (!file) return;
    try {
      const written = await updateDictionaryConfig(this.app, file, change);
      if (written) {
        change(this.config);
        // An unchosen order means "let the dictionary decide", resolved at start
        // from whichever preset is quick *then*. Making another preset quick, or
        // deleting the quick one, moves that answer out from under the form —
        // which still shows the old one. Pin what the user is looking at.
        this.orderChosen = true;
      } else {
        new Notice(
          "Could not save: this note's fsrs-vocabulary property holds something other " +
            "than a settings block. Clear or fix it first.",
        );
      }
    } catch (err) {
      // The note can be deleted or its frontmatter left unparseable while the
      // dialog is open; say so instead of dying as an unhandled rejection.
      new Notice(`Could not save preset: ${errorMessage(err)}`);
    }
    this.render();
  }

  private start(): void {
    if (this.columns.length > 0 && this.front.length === 0) return;
    this.close();
    this.onStart({
      columns: this.columns.length > 0 ? { front: [...this.front], back: [...this.back] } : null,
      pool: this.pool,
      order: this.orderChosen ? this.order : null,
      record: this.record,
    });
  }
}

/** One-line text prompt — Obsidian has no built-in equivalent. */
class NamePromptModal extends Modal {
  private readonly title: string;
  private readonly initial: string;
  private readonly onSubmit: (value: string) => void;

  constructor(app: App, title: string, initial: string, onSubmit: (value: string) => void) {
    super(app);
    this.title = title;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  override onOpen(): void {
    this.contentEl.createEl("h3", { text: this.title });
    const input = this.contentEl.createEl("input", { type: "text" });
    input.value = this.initial;
    const controls = this.contentEl.createDiv({ cls: "modal-button-container" });
    const submit = (): void => {
      const value = input.value.trim();
      if (value === "") return;
      this.close();
      this.onSubmit(value);
    };
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") submit();
    });
    const ok = controls.createEl("button", { cls: "mod-cta", text: "Rename" });
    ok.addEventListener("click", submit);
    const cancel = controls.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.close();
    });
    input.focus();
    input.select();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
