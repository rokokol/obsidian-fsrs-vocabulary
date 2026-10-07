import { PluginSettingTab, Setting, type App, type ToggleComponent } from "obsidian";
import type FsrsVocabularyPlugin from "../main";
import { iconicInstalled } from "../obsidian/iconic";
import {
  MAX_REMIND_MINUTES,
  parseRemindMinutes,
  sanitizeColumns,
  sanitizePropertyKeys,
  SORT_LABELS,
  type DefaultView,
  type SortMode,
} from "../settings";

/** Where to send someone who does not have Iconic yet. */
const ICONIC_URL = "https://github.com/gfxholo/iconic";

export class FsrsVocabularySettingTab extends PluginSettingTab {
  private readonly plugin: FsrsVocabularyPlugin;

  constructor(app: App, plugin: FsrsVocabularyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("New dictionary columns")
      .setDesc(
        "Comma-separated columns a new dictionary is created with. The first is " +
          "the card front (the word/key); the rest are its fields. Any number of " +
          "columns is fine.",
      )
      .addText((text) => {
        text.setPlaceholder("word, transcription, translation");
        text.setValue(this.plugin.settings.newDictionaryColumns.join(", "));
        const commit = (): void => {
          const columns = sanitizeColumns(text.getValue());
          if (columns.length > 0) this.plugin.settings.newDictionaryColumns = columns;
          text.setValue(this.plugin.settings.newDictionaryColumns.join(", "));
          void this.plugin.saveSettings();
        };
        text.inputEl.addEventListener("blur", commit);
      });

    new Setting(containerEl)
      .setName("Default view")
      .setDesc("How dictionary notes open: the interactive view, or plain markdown.")
      .addDropdown((dropdown) => {
        dropdown.addOption("dictionary", "Interactive dictionary");
        dropdown.addOption("markdown", "Markdown source");
        dropdown.setValue(this.plugin.settings.defaultView);
        dropdown.onChange((value) => {
          this.plugin.settings.defaultView = value as DefaultView;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default word order")
      .setDesc("How words are sorted when a dictionary opens.")
      .addDropdown((dropdown) => {
        for (const [mode, label] of Object.entries(SORT_LABELS)) {
          dropdown.addOption(mode, label);
        }
        dropdown.setValue(this.plugin.settings.defaultSort);
        dropdown.onChange((value) => {
          this.plugin.settings.defaultSort = value as SortMode;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Target retention")
      .setDesc("Desired probability of recall for FSRS scheduling (0.7–0.97).")
      .addSlider((slider) => {
        slider
          .setLimits(0.7, 0.97, 0.01)
          .setValue(this.plugin.settings.fsrsRetention)
          .onChange((value) => {
            this.plugin.settings.fsrsRetention = value;
            void this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Displayed properties")
      .setDesc(
        "Frontmatter keys shown in the dictionary header, comma-separated, in this " +
          "order. Wikilink/URL values render as links. Leave empty (the default) to " +
          "show every property.",
      )
      .addText((text) => {
        text.setPlaceholder("up, source, related, level");
        text.setValue(this.plugin.settings.properties.join(", "));
        const commit = (): void => {
          const keys = sanitizePropertyKeys(text.getValue());
          this.plugin.settings.properties = keys;
          text.setValue(keys.join(", "));
          void this.plugin.saveSettings();
          this.plugin.refreshRendered();
        };
        text.inputEl.addEventListener("blur", commit);
      });

    new Setting(containerEl)
      .setName("Keep the question when revealing")
      .setDesc(
        "Show the answer under the question instead of turning the card over, so " +
          "every field ends up on one side.",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.keepQuestionOnReveal);
        toggle.onChange((value) => {
          this.plugin.settings.keepQuestionOnReveal = value;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Count muted dictionaries")
      .setDesc(
        "Include muted dictionaries in vault-wide stats and in the review-everything " +
          "session. A single stats block can override this with +muted or -muted, " +
          "on its own line or after the scope.",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.statsIncludeMuted);
        toggle.onChange((value) => {
          this.plugin.settings.statsIncludeMuted = value;
          void this.plugin.saveSettings();
          this.plugin.refreshRendered();
        });
      });

    new Setting(containerEl)
      .setName("Review scope")
      .setDesc("Pull due cards from the active dictionary only, or from the whole vault.")
      .addDropdown((dropdown) => {
        dropdown.addOption("note", "Active note");
        dropdown.addOption("vault", "Whole vault");
        dropdown.setValue(this.plugin.settings.reviewScope);
        dropdown.onChange((value) => {
          this.plugin.settings.reviewScope = value === "vault" ? "vault" : "note";
          void this.plugin.saveSettings();
        });
      });

    this.renderReminders(containerEl);
    this.renderIntegrations(containerEl);
  }

  /**
   * The Iconic integration, drawn whether or not Iconic is installed: someone who
   * has never heard of the plugin should still be able to learn from this tab that
   * the dashboard and the shelf can show icons. Without it the toggle is disabled
   * rather than hidden,
   * because switching it on would change nothing.
   *
   * Only the disk can answer whether Iconic is there, so the row starts disabled
   * and is enabled a tick later. That order round the other way would offer a
   * switch that does nothing for as long as the check takes.
   */
  private renderIntegrations(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Integrations").setHeading();

    const setting = new Setting(containerEl)
      .setName("Icons from Iconic")
      .setDesc(
        "Show the icons you set in Iconic: beside every name in the dashboard, and " +
          "as a picture tile in the dictionary tiles view, where dictionaries without " +
          "one fall into a plain list below. Off means no icons and one plain list.",
      );

    // Built now, shown only once the plugin is known to be missing — the check is
    // usually a hit, and a "not installed" line that blinks past is worse than none.
    const hint = setting.descEl.createDiv({ cls: "fsrs-vocabulary-setting-hint" });
    hint.hide();
    hint.appendText("Needs the ");
    hint.createEl("a", { href: ICONIC_URL, text: "Iconic" });
    hint.appendText(" plugin, which this vault does not have.");

    setting.addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.iconicIntegration);
      toggle.setDisabled(true);
      toggle.onChange((value) => {
        this.plugin.settings.iconicIntegration = value;
        void this.plugin.saveSettings();
        this.plugin.refreshIconic();
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

  private renderReminders(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Reminders").setHeading();

    const { settings } = this.plugin;
    // The switches below only mean anything while the master one is on, so they
    // are built once and hidden in place rather than redrawing the whole tab.
    const dependent: HTMLElement[] = [];
    const syncDependent = (): void => {
      for (const el of dependent) el.toggle(settings.remindersEnabled);
    };

    new Setting(containerEl)
      .setName("Remind me about due cards")
      .setDesc("Turn off to silence every reminder. Individual dictionaries can be muted too.")
      .addToggle((toggle) => {
        toggle.setValue(settings.remindersEnabled);
        toggle.onChange((value) => {
          settings.remindersEnabled = value;
          void this.plugin.saveSettings();
          this.plugin.remindersChanged();
          syncDependent();
        });
      });

    dependent.push(
      new Setting(containerEl)
        .setName("On start-up")
        .setDesc("Show a notice when Obsidian opens with cards waiting.")
        .addToggle((toggle) => {
          toggle.setValue(settings.remindOnStartup);
          toggle.onChange((value) => {
            settings.remindOnStartup = value;
            void this.plugin.saveSettings();
          });
        }).settingEl,
    );

    const repeat = new Setting(containerEl)
      .setName("Repeat every")
      .setDesc(
        `Minutes between reminders while Obsidian stays open, up to ${MAX_REMIND_MINUTES.toString()}. ` +
          "Empty or zero means only on start-up.",
      )
      .addText((text) => {
        // Left as a text field: `type="number"` hands back an empty string for
        // anything it cannot parse, so a fumbled "soon" would be indistinguishable
        // from clearing the field and would switch the reminder off silently.
        text.inputEl.inputMode = "numeric";
        text.inputEl.size = 6;
        text.setPlaceholder("0");
        text.setValue(
          settings.remindEveryMinutes === 0 ? "" : settings.remindEveryMinutes.toString(),
        );
        // Committed on blur, like the other typed fields: re-arming on every
        // keystroke would restart the clock once per digit, and "30" would spend
        // a moment meaning three minutes.
        const commit = (): void => {
          const minutes = parseRemindMinutes(text.getValue(), settings.remindEveryMinutes);
          settings.remindEveryMinutes = minutes;
          text.setValue(minutes === 0 ? "" : minutes.toString());
          void this.plugin.saveSettings();
          this.plugin.remindersChanged();
        };
        text.inputEl.addEventListener("blur", commit);
      });
    dependent.push(repeat.settingEl);

    dependent.push(
      new Setting(containerEl)
        .setName("Status bar counter")
        .setDesc("Show how many cards are due; click it to start reviewing.")
        .addToggle((toggle) => {
          toggle.setValue(settings.statusBarCounter);
          toggle.onChange((value) => {
            settings.statusBarCounter = value;
            void this.plugin.saveSettings();
            this.plugin.remindersChanged();
          });
        }).settingEl,
    );

    syncDependent();
  }
}
