import css from "@eslint/css";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: ["main.js", "dist/**", "node_modules/**", "**/*.mjs"],
  },
  // The rules the community directory's automated review applies. Its first entry has
  // no `files` and sets JavaScript rules that cannot parse a stylesheet, so it skips CSS
  ...obsidianmd.configs.recommended.map((config) =>
    config.files ? config : { ...config, ignores: ["**/*.css"] },
  ),
  // The directory lints styles.css too, so lint it here with the same kind of rules
  {
    files: ["**/*.css"],
    language: "css/css",
    plugins: { css },
    extends: [css.configs.recommended],
    rules: {
      "css/no-important": "error",
      // Obsidian defines the --text-normal family of variables when the app runs, so the
      // linter cannot see them
      "css/no-invalid-properties": ["error", { allowUnknownVariables: true }],
      // Baseline describes the web in general. Obsidian ships its own engine and the
      // manifest sets the oldest app version, which is the measure for what is safe here
      "css/use-baseline": "off",
    },
  },
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "import/order": [
        "warn",
        {
          "newlines-between": "never",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        { allowExpressions: true },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // The tests run under node and never ship to a phone, which is what the rule
    // guards against.
    files: ["tests/**/*.ts"],
    rules: { "obsidianmd/no-nodejs-modules": "off" },
  },
);
