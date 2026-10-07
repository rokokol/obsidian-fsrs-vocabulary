import { Modal, Notice, Setting, type App } from "obsidian";
import { parseImport, type ImportResult } from "../model/import";
import { ConfirmModal } from "./confirmModal";

/** Paste multiple words at once (one per line, columns separated by `|`/`;`). */
export class ImportWordsModal extends Modal {
  private readonly columns: string[];
  private readonly onSubmit: (rows: Record<string, string>[]) => void;

  constructor(app: App, columns: string[], onSubmit: (rows: Record<string, string>[]) => void) {
    super(app);
    this.columns = columns;
    this.onSubmit = onSubmit;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Import words" });
    contentEl.createEl("p", {
      cls: "dictionary-notes-import-hint",
      text: `One word per line. Columns: ${this.columns.join(" / ")} — separated by | or ;`,
    });

    const textarea = contentEl.createEl("textarea", { cls: "dictionary-notes-import-input" });
    textarea.rows = 10;
    textarea.focus();

    const count = contentEl.createDiv({ cls: "dictionary-notes-import-count" });
    const parse = (): ImportResult => parseImport(textarea.value, this.columns);
    const updateCount = (): void => {
      const { rows, incomplete } = parse();
      const parts = [`${rows.length.toString()} words`];
      if (incomplete > 0) parts.push(`${incomplete.toString()} skipped (incomplete)`);
      count.setText(parts.join(" · "));
    };
    textarea.addEventListener("input", updateCount);
    updateCount();

    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText("Import")
        .setCta()
        .onClick(() => {
          this.attemptImport(parse());
        });
    });
  }

  /** Confirm before dropping incomplete rows; never skip them silently. */
  private attemptImport(result: ImportResult): void {
    const { rows, incomplete } = result;
    if (rows.length === 0) {
      new Notice(
        incomplete > 0
          ? `Every row (${incomplete.toString()}) is missing a field. Nothing imported.`
          : "Nothing to import.",
      );
      return;
    }
    if (incomplete > 0) {
      const message =
        `${incomplete.toString()} row(s) are missing fields and will be skipped. ` +
        `Import ${rows.length.toString()} complete word(s)?`;
      new ConfirmModal(this.app, message, "Import", () => {
        this.close();
        this.onSubmit(rows);
      }).open();
      return;
    }
    this.close();
    this.onSubmit(rows);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
