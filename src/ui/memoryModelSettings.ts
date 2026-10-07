import { Notice, Setting } from "obsidian";
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

/**
 * The memory model section: how much history there is, what the last fit found, and
 * the two buttons. Counting the history reads every device's log, so those numbers
 * arrive a moment after the section is drawn.
 */
export function renderMemoryModel(containerEl: HTMLElement, plugin: FsrsVocabularyPlugin): void {
  new Setting(containerEl).setName("Memory model").setHeading();
  const { fitter } = plugin;
  if (!fitter) return;

  const history = new Setting(containerEl)
    .setName("Review history")
    .setDesc("Counting the reviews logged on every device…");
  void fitter
    .counts()
    .then(({ reviews, items }) => {
      history.setDesc(
        `${reviews.toString()} reviews logged on all your devices, ${items.toString()} of them ` +
          `usable to fit the model. It is first fitted at ${MIN_ITEMS.toString()} usable reviews, ` +
          "and again each time as many more have come in.",
      );
    })
    .catch((err: unknown) => {
      history.setDesc(`Could not read the review history: ${errorMessage(err)}`);
    });

  new Setting(containerEl)
    .setName("Weights in use")
    .setDesc(
      plugin.settings.fsrsWeights
        ? "Fitted to your own reviews. New weights are only adopted when they predict your reviews better."
        : "The defaults. Your own replace them once a fit predicts your reviews better.",
    );

  new Setting(containerEl)
    .setName("Last fit")
    .setDesc(`${describeFit(plugin.settings.fsrsFit)} Lower prediction error is better.`)
    .addButton((button) => {
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

  new Setting(containerEl)
    .setName("Reset to default weights")
    .setDesc(
      "Schedule with the default weights again, and move the due dates to match. The next automatic fit waits for new reviews, as after any fit.",
    )
    .addButton((button) => {
      button
        .setButtonText("Reset")
        .setDisabled(plugin.settings.fsrsWeights === null)
        .onClick(() => {
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
}
