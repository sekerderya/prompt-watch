import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * One flat config for the whole monorepo.
 *
 * The project previously had no linter at all, while CI ran a "Lint (if
 * configured)" step that swallowed the failure and printed "Lint skipped" — a
 * green check for a check that never ran.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "apps/web/next-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The OpenAI streaming chunk shapes and Prisma raw rows are genuinely
      // dynamic; those spots are annotated rather than fought.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // Browser globals for the dashboard.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // Tests reach for `any` freely when building fixtures.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
