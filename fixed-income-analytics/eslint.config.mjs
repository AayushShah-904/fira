import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/*.d.ts",
      "**/routeTree.gen.ts",
      "rate-discovery-agent/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Shared, API, Scraper — Node environment
  {
    files: [
      "packages/shared/src/**/*.ts",
      "packages/api/src/**/*.ts",
      "packages/scraper/src/**/*.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  // Test files — relaxed rules
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Config files
  {
    files: ["*.config.{js,mjs,ts}", "**/*.config.{js,mjs,ts}"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
