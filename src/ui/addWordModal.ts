import { Modal, Setting, type App } from "obsidian";
import { missingColumns, sanitizeCell } from "../model/word";
import { enhanceFieldInput } from "../obsidian/fieldInput";

/**
 * Prompt for the fields of a new word. Every field is required: submitting with
 * a blank field shows an inline warning instead of adding an incomplete word. On
 * success the sanitized values are handed to `onSubmit`; cancelling yields none.
 */
export class AddWordModal extends Modal {
  private readonly columns: string[];
  private readonly sourcePath: string;
  private readonly draft: Record<string, string> = {};
  private readonly onSubmit: (values: Record<string, string>) => void;
  private errorEl: HTMLElement | null = null;
  private result: Record<string, string> | null = null;

  constructor(
    app: App,
    columns: string[],
    sourcePath: string,
    onSubmit: (values: Record<string, string>) => void,
  ) {
    super(app);
    this.columns = columns;
    this.sourcePath = sourcePath;
    this.onSubmit = onSubmit;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Add word" });

    for (const column of this.columns) {
      this.draft[column] = "";
      new Setting(contentEl).setName(column).addText((text) => {
        text.onChange((value) => {
          this.draft[column] = value;
          this.errorEl?.hide();
        });
        if (column === this.columns[0]) {
          window.setTimeout(() => {
            text.inputEl.focus();
          }, 0);
        }
        enhanceFieldInput(this.app, text.inputEl, this.sourcePath);
        text.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") this.submit();
        });
      });
    }

    this.errorEl = contentEl.createDiv({ cls: "dictionary-notes-modal-error" });
    this.errorEl.hide();

    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText("Add")
        .setCta()
        .onClick(() => {
          this.submit();
        });
    });
  }

  private submit(): void {
    const values: Record<string, string> = {};
    for (const column of this.columns) values[column] = sanitizeCell(this.draft[column] ?? "");
    const missing = missingColumns(values, this.columns);
    if (missing.length > 0) {
      this.showError(`Fill in every field — ${missing.join(", ")} left empty.`);
      return;
    }
    this.result = values;
    this.close();
  }

  private showError(message: string): void {
    if (!this.errorEl) return;
    this.errorEl.setText(message);
    this.errorEl.show();
  }

  override onClose(): void {
    this.contentEl.empty();
    if (this.result) this.onSubmit(this.result);
  }
}
