import { Notice, type ButtonComponent, type Setting, type SettingDefinition } from "obsidian";
import type FsrsVocabularyPlugin from "../main";
import { MIN_ITEMS, type FitOutcome } from "../optimizer/fit";
import type { FitRecord } from "../settings";
import { errorMessage } from "../util";
import { ConfirmModal } from "./confirmModal";

const loss = (value: number | null): string => (value === null ? "n/a" : value.toFixed(3));

/** One line on what the last fit found. */
function describeFit(fit: FitRecord | null): string {
  if (!fit) return "No fit has run yet.";
  const when = new Date(fit.at).toLocaleString();
  const scores = `prediction error ${loss(fit.lossBefore)} → ${loss(fit.lossAfter)}`;
  return fit.status === "adopted"
    ? `${when}: adopted, ${scores}.`
    : `${when}: kept the weights in use, the new fit predicted no better (${scores}).`;
}

/** What a fit asked for from this tab says when it is done. */
function outcomeNotice(outcome: FitOutcome): string {
  if (outcome.status === "not-enough") {
    return `Not enough review history yet: ${outcome.items.toString()} of ${MIN_ITEMS.toString()} usable reviews.`;
  }
  return outcome.status === "adopted"
    ? "New weights adopted: they predict your reviews better."
    : "The weights in use still predict your reviews best; nothing changed.";
}

const weightsDesc = (plugin: FsrsVocabularyPlugin): string =>
  plugin.settings.fsrsWeights
    ? "Fitted to your own reviews. New weights are only adopted when they predict your reviews better."
    : "The defaults. Your own replace them once a fit predicts your reviews better.";

const lastFitDesc = (plugin: FsrsVocabularyPlugin): string =>
  `${describeFit(plugin.settings.fsrsFit)} Lower prediction error is better.`;

/**
 * Keep a row in step with the fits: `refresh` runs each time one lands, for as long
 * as the row is drawn. The returned function is the row's cleanup, which Obsidian
 * calls before it draws the row again or drops it.
 */
function followFits(plugin: FsrsVocabularyPlugin, refresh: () => void): () => void {
  plugin.fitListeners.add(refresh);
  return () => {
    plugin.fitListeners.delete(refresh);
  };
}

/**
 * The rows of the memory model section: how much history there is, what the last fit
 * found, and the two buttons. They are drawn by hand because what they show is not a
 * stored value: counting the history reads every device's log, so that number arrives
 * a moment after the row is drawn, and a fit changes the rest while the tab is open.
 */
export function memoryModelItems(plugin: FsrsVocabularyPlugin): SettingDefinition[] {
  return [
    {
      name: "Review history",
      render: (setting: Setting) => {
        const { fitter } = plugin;
        if (!fitter) return;
        setting.setDesc("Counting the reviews logged on every device…");
        fitter
          .counts()
          .then(({ reviews, items }) => {
            setting.setDesc(
              `${reviews.toString()} reviews logged on all your devices, ${items.toString()} of them ` +
                `usable to fit the model. It is first fitted at ${MIN_ITEMS.toString()} usable reviews, ` +
                "and again each time as many more have come in.",
            );
          })
          .catch((err: unknown) => {
            setting.setDesc(`Could not read the review history: ${errorMessage(err)}`);
          });
      },
    },
    {
      name: "Weights in use",
      render: (setting: Setting) => {
        const show = (): void => {
          setting.setDesc(weightsDesc(plugin));
        };
        show();
        return followFits(plugin, show);
      },
    },
    {
      name: "Last fit",
      render: (setting: Setting) => {
        const { fitter } = plugin;
        if (!fitter) return;
        const show = (): void => {
          setting.setDesc(lastFitDesc(plugin));
        };
        show();
        setting.addButton((button) => {
          button.setButtonText("Optimize now").onClick(async () => {
            button.setDisabled(true).setButtonText("Optimizing…");
            try {
              new Notice(outcomeNotice(await fitter.fitNow()));
            } catch (err) {
              new Notice(`Could not fit the memory model: ${errorMessage(err)}`);
            } finally {
              button.setDisabled(false).setButtonText("Optimize now");
            }
          });
        });
        return followFits(plugin, show);
      },
    },
    {
      name: "Reset to default weights",
      desc: "Schedule with the default weights again, and move the due dates to match. The next automatic fit waits for new reviews, as after any fit.",
      render: (setting: Setting) => {
        const { fitter } = plugin;
        if (!fitter) return;
        const buttons: ButtonComponent[] = [];
        setting.addButton((button) => {
          buttons.push(button);
          button.setButtonText("Reset").onClick(() => {
            new ConfirmModal(
              plugin.app,
              "Schedule with the default weights instead of the ones fitted to your reviews?",
              "Reset",
              () => {
                fitter.reset().catch((err: unknown) => {
                  new Notice(`Could not reset the weights: ${errorMessage(err)}`);
                });
              },
            ).open();
          });
        });
        // Nothing to reset until a fit has adopted weights of the user's own
        const show = (): void => {
          for (const button of buttons) button.setDisabled(plugin.settings.fsrsWeights === null);
        };
        show();
        return followFits(plugin, show);
      },
    },
  ];
}
