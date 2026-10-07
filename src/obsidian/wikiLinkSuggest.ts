import { AbstractInputSuggest, type App, type TFile } from "obsidian";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** The `[[…` fragment under the caret, and where it starts in the value. */
interface LinkContext {
  query: string;
  start: number;
}

/** Link text for a file: bare basename for notes, full name for other files. */
function linkText(file: TFile): string {
  return file.extension === "md" ? file.basename : file.name;
}

/**
 * `[[` wiki-link autocomplete for a plain text field (input or textarea). When
 * the caret sits inside an unclosed `[[…`, it suggests every vault file (notes,
 * images, audio, anything — like Obsidian's own link suggester) and replaces the
 * fragment with a `[[…]]` link on selection. A leading `!` (embed) is preserved.
 */
export class WikiLinkSuggest extends AbstractInputSuggest<TFile> {
  private readonly input: TextField;

  constructor(app: App, input: TextField) {
    // AbstractInputSuggest is typed for input/div, but only reads value/caret,
    // which textarea also provides; this class never uses its value helpers.
    super(app, input as HTMLInputElement);
    this.input = input;
  }

  private linkContext(): LinkContext | null {
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const start = before.lastIndexOf("[[");
    if (start === -1) return null;
    const fragment = before.slice(start + 2);
    if (fragment.includes("]]")) return null;
    return { query: fragment, start };
  }

  protected getSuggestions(): TFile[] {
    const context = this.linkContext();
    if (context === null) return [];
    const query = context.query.toLowerCase();
    return this.app.vault
      .getFiles()
      .filter((file) => file.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, this.limit);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ text: file.basename });
    if (file.extension !== "md") {
      el.createEl("small", { text: file.path, cls: "fsrs-vocabulary-suggest-path" });
    }
  }

  override selectSuggestion(file: TFile): void {
    const context = this.linkContext();
    if (context === null) return;
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const head = value.slice(0, context.start) + `[[${linkText(file)}]]`;
    this.input.value = head + value.slice(caret);
    this.input.setSelectionRange(head.length, head.length);
    this.input.dispatchEvent(new Event("input"));
    this.close();
  }
}
