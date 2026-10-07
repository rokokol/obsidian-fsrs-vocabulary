/**
 * Stand-in for the `obsidian` package under vitest.
 *
 * The real package ships types and nothing else — Obsidian injects the
 * implementation at runtime — so a module that imports any *value* from it cannot
 * be loaded in a test at all. Most of the code under test avoids that by taking
 * `App` as a type and having its I/O injected, but a few modules genuinely need a
 * value: `TFile` for an `instanceof` check, `getFrontMatterInfo` to find where
 * frontmatter ends.
 *
 * Deliberately tiny. Anything added here is behaviour a test would then be
 * asserting against this file rather than against Obsidian, so a module that wants
 * more of the API than this is a module to test through an injected seam instead.
 */

/** Enough of `TFile` for `instanceof` and the fields the plugin reads. */
export class TFile {
  path = "";
  basename = "";
  extension = "md";
}

/**
 * Everything else the plugin imports as a value, as a function that throws.
 *
 * An alias makes a missing export `undefined` rather than a resolution error, so a
 * module reaching for an un-stubbed part of the API would fail — or worse, quietly
 * pass — only along the branch a test happens to take. Throwing turns that into a
 * named failure at the moment of use, and the message says what to do about it.
 */
function unimplemented(name: string): () => never {
  return () => {
    throw new Error(
      `${name} is not implemented by the obsidian test stub. Inject it as a seam, ` +
        `or add it here if the behaviour under test genuinely needs it.`,
    );
  };
}

export const getFrontMatterInfo = unimplemented("getFrontMatterInfo");
export const setIcon = unimplemented("setIcon");
