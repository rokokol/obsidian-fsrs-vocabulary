/**
 * Turning `![[Some dictionary]]` into that dictionary's stats.
 *
 * Embedding a dictionary note the normal way transcludes the whole thing — theory,
 * every word, the lot — which is almost never what someone wants in the middle of
 * another note. What they want is what the dictionary is worth to them right now,
 * and that is exactly what the stats block already draws.
 */

/** Link target of an embed element, or null when it is not one we take over. */
export function embedTarget(embed: Pick<HTMLElement, "getAttribute">): string | null {
  const src = embed.getAttribute("src")?.trim();
  if (src === undefined || src === "") return null;
  // `![[Note#Heading]]` and `![[Note#^block]]` ask for one part of the note, which
  // is a different request; only a whole-note embed becomes stats.
  return src.includes("#") ? null : src;
}

/**
 * Replace every embed of a dictionary with a container of our own and hand it to
 * `render`.
 *
 * The element is replaced rather than filled: Obsidian loads embeds itself, some
 * time after the post-processor runs, and it finds them by the `internal-embed`
 * class. Leaving that class in place means our content and Obsidian's race for the
 * same node, and Obsidian wins.
 */
export function renderDictionaryEmbeds(
  el: HTMLElement,
  resolve: (target: string) => boolean,
  render: (target: string, container: HTMLElement) => void,
): void {
  for (const embed of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
    const target = embedTarget(embed);
    if (target === null || !resolve(target)) continue;
    const container = createDiv({ cls: "fsrs-vocabulary-embed" });
    embed.replaceWith(container);
    render(target, container);
  }
}
