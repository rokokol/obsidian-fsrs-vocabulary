import {
  debounce,
  PluginSettingTab,
  type App,
  type Debouncer,
  type Setting,
  type SettingDefinitionItem,
  type ToggleComponent,
} from "obsidian";
import type FsrsVocabularyPlugin from "../main";
import { iconicInstalled } from "../obsidian/iconic";
import {
  DEFAULT_SETTINGS,
  MAX_REMIND_MINUTES,
  readControl,
  RETENTION_MAX,
  RETENTION_MIN,
  sanitizeColumns,
  SORT_LABELS,
  writeControl,
} from "../settings";
import { memoryModelItems } from "./memoryModelSettings";

/** Where to send someone who does not have Iconic yet. */
const ICONIC_URL = "https://github.com/gfxholo/iconic";

/**
 * How long typing in the properties field waits before the open notes are redrawn.
 * The field reports every keystroke, and a redraw reads every dictionary in view.
 */
const REDRAW_DELAY_MS = 400;

export class FsrsVocabularySettingTab extends PluginSettingTab {
  private readonly plugin: FsrsVocabularyPlugin;
  private readonly redrawSoon: Debouncer<[], void>;

  constructor(app: App, plugin: FsrsVocabularyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.redrawSoon = debounce(
      () => {
        this.plugin.refreshRendered();
      },
      REDRAW_DELAY_MS,
      true,
    );
  }

  override hide(): void {
    // A redraw still waiting would be lost if the tab closed on it
    this.redrawSoon.run();
    super.hide();
  }

  override getControlValue(key: string): unknown {
    return readControl(this.plugin.settings, key);
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const effects = writeControl(this.plugin.settings, key, value);
    if (effects === null) return;
    if (effects.includes("rendered")) {
      if (key === "properties") this.redrawSoon();
      else this.plugin.refreshRendered();
    }
    if (effects.includes("reminders")) this.plugin.remindersChanged();
    if (effects.includes("iconic")) this.plugin.refreshIconic();
    await this.plugin.saveSettings();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const remindersOn = (): boolean => this.plugin.settings.remindersEnabled;
    return [
      {
        name: "New dictionary columns",
        desc:
          "Comma-separated columns a new dictionary is created with. The first is " +
          "the card front (the word/key); the rest are its fields. Any number of " +
          "columns is fine.",
        control: {
          type: "text",
          key: "newDictionaryColumns",
          placeholder: "Example: word, transcription, translation",
          validate: (value) =>
            sanitizeColumns(value).length === 0 ? "Enter at least one column." : undefined,
        },
      },
      {
        name: "Default view",
        desc: "How dictionary notes open: the interactive view, or plain Markdown.",
        control: {
          type: "dropdown",
          key: "defaultView",
          options: { dictionary: "Interactive dictionary", markdown: "Markdown source" },
        },
      },
      {
        name: "Default word order",
        desc: "How words are sorted when a dictionary opens.",
        control: { type: "dropdown", key: "defaultSort", options: SORT_LABELS },
      },
      {
        name: "Target retention",
        desc: `Desired probability of recall when scheduling reviews (${RETENTION_MIN.toString()}–${RETENTION_MAX.toString()}).`,
        control: {
          type: "slider",
          key: "fsrsRetention",
          min: RETENTION_MIN,
          max: RETENTION_MAX,
          step: 0.01,
          defaultValue: DEFAULT_SETTINGS.fsrsRetention,
        },
      },
      {
        name: "Displayed properties",
        desc:
          "Frontmatter keys shown in the dictionary header, comma-separated, in this " +
          "order. Wikilink/URL values render as links. Leave empty (the default) to " +
          "show every property.",
        control: {
          type: "text",
          key: "properties",
          placeholder: "Example: up, source, related, level",
        },
      },
      {
        name: "Keep the question when revealing",
        desc:
          "Show the answer under the question instead of turning the card over, so " +
          "every field ends up on one side.",
        control: { type: "toggle", key: "keepQuestionOnReveal" },
      },
      {
        name: "Count muted dictionaries",
        desc:
          "Include muted dictionaries in vault-wide stats and in the review-everything " +
          "session. A single stats block can override this with +muted or -muted, " +
          "on its own line or after the scope.",
        control: { type: "toggle", key: "statsIncludeMuted" },
      },
      {
        name: "Review scope",
        desc: "Pull due cards from the active dictionary only, or from the whole vault.",
        control: {
          type: "dropdown",
          key: "reviewScope",
          options: { note: "Active note", vault: "Whole vault" },
        },
      },
      {
        type: "group",
        heading: "Memory model",
        visible: () => this.plugin.fitter !== null,
        items: memoryModelItems(this.plugin),
      },
      {
        type: "group",
        heading: "Reminders",
        items: [
          {
            name: "Remind me about due cards",
            desc: "Turn off to silence every reminder. Individual dictionaries can be muted too.",
            control: { type: "toggle", key: "remindersEnabled" },
          },
          // The rows below only mean anything while the master switch is on
          {
            name: "On start-up",
            desc: "Show a notice when Obsidian opens with cards waiting.",
            visible: remindersOn,
            control: { type: "toggle", key: "remindOnStartup" },
          },
          {
            name: "Repeat every",
            desc:
              `Minutes between reminders while Obsidian stays open, up to ${MAX_REMIND_MINUTES.toString()}. ` +
              "Empty or zero means only on start-up.",
            visible: remindersOn,
            control: {
              type: "number",
              key: "remindEveryMinutes",
              placeholder: "0",
              min: 0,
              max: MAX_REMIND_MINUTES,
              step: 1,
              defaultValue: 0,
            },
          },
          {
            name: "Status bar counter",
            desc: "Show how many cards are due; click it to start reviewing.",
            visible: remindersOn,
            control: { type: "toggle", key: "statusBarCounter" },
          },
        ],
      },
      {
        type: "group",
        heading: "Integrations",
        items: [
          {
            name: "Iconic icons",
            desc:
              "Show the icons you set in Iconic: beside every name in the dashboard, and " +
              "as a picture tile in the dictionary tiles view, where dictionaries without " +
              "one fall into a plain list below. Off means no icons and one plain list.",
            render: (setting) => {
              this.renderIconic(setting);
            },
          },
        ],
      },
    ];
  }

  /**
   * The Iconic integration, drawn whether or not Iconic is installed: someone who
   * has never heard of the plugin should still be able to learn from this tab that
   * the dashboard and the shelf can show icons. Without it the toggle is disabled
   * rather than hidden, because switching it on would change nothing.
   *
   * Only the disk can answer whether Iconic is there, so the row starts disabled
   * and is enabled a tick later. That order round the other way would offer a
   * switch that does nothing for as long as the check takes. The answer can change
   * between two visits to the tab, so the row asks again each time it is drawn,
   * which a plain toggle definition has no hook for.
   */
  private renderIconic(setting: Setting): void {
    // Built now, shown only once the plugin is known to be missing — the check is
    // usually a hit, and a "not installed" line that blinks past is worse than none.
    const hint = setting.descEl.createDiv({ cls: "fsrs-vocabulary-setting-hint" });
    hint.hide();
    hint.appendText("Needs the ");
    hint.createEl("a", { href: ICONIC_URL, text: "Iconic" });
    hint.appendText(" plugin, which this vault does not have.");

    setting.addToggle((toggle) => {
      toggle.setValue(readControl(this.plugin.settings, "iconicIntegration") === true);
      toggle.setDisabled(true);
      toggle.onChange((value) => {
        void this.setControlValue("iconicIntegration", value);
      });
      void this.resolveIconic(toggle, hint);
    });
  }

  /**
   * Let the toggle go once Iconic is found, or explain why it will not move. Both
   * elements may be detached by then — the tab was closed or redisplayed — in which
   * case this writes to markup nobody sees, which is harmless.
   */
  private async resolveIconic(toggle: ToggleComponent, hint: HTMLElement): Promise<void> {
    if (await iconicInstalled(this.app)) toggle.setDisabled(false);
    else hint.show();
  }
}
