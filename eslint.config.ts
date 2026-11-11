/// <reference types="node" />
import {defineConfig} from "eslint/config";
import prettierConfig from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

export default defineConfig([
    // 1. Globally ignored paths (build output, deps, and the excluded legacy tree).
    {
        ignores: [".claude/worktrees/**", "**/node_modules/**", "**/dist/**"],
    },

    // 2. Parser setup shared across the monorepo.
    {
        languageOptions: {
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    // 3. TypeScript ESLint recommended baseline.
    ...tseslint.configs.recommended,

    // 4. Shared project rules.
    {
        files: ["**/*.{js,jsx,ts,tsx}"],
        plugins: {
            "simple-import-sort": simpleImportSort,
            "unused-imports": unusedImports,
        },
        rules: {
            // Import / export ordering.
            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error",
            "@typescript-eslint/consistent-type-imports": [
                "error",
                {prefer: "type-imports", fixStyle: "separate-type-imports"},
            ],

            // Unused code — delegated to the unused-imports plugin so we get
            // auto-fixable import removal; the core/TS rules are turned off to
            // avoid duplicate reports. Names prefixed with `_` are intentional.
            "@typescript-eslint/no-unused-vars": "off",
            "unused-imports/no-unused-imports": "error",
            "unused-imports/no-unused-vars": [
                "warn",
                {
                    vars: "all",
                    varsIgnorePattern: "^_",
                    args: "after-used",
                    argsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],

            // Language correctness.
            "no-var": "error",
            "prefer-const": "error",
            "@typescript-eslint/no-explicit-any": "warn", // TODO: consider promoting to "error" once existing anys are typed.

            // Stylistic preferences (formatting itself is handled by Prettier).
            "prefer-template": "warn",
            "object-shorthand": "warn",
        },
    },

    // 5. Disable rules that conflict with Prettier.
    prettierConfig,

    // 6. Re-enable rules that Prettier turns off defensively but that don't
    //    actually conflict with its output (must come after prettierConfig).
    {
        files: ["**/*.{js,jsx,ts,tsx}"],
        rules: {
            curly: ["error", "all"],
        },
    },
]);
