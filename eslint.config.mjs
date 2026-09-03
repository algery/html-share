import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const NODE_GLOBALS = {
  Buffer: "readonly",
  AbortSignal: "readonly",
  URL: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
};

export default defineConfig(
  {
    ignores: ["**/.next/**", "**/coverage/**", "**/dist/**", "**/node_modules/**", "**/out/**"],
  },
  {
    files: ["**/*.{js,cjs,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: NODE_GLOBALS,
    },
  },
  {
    files: ["**/*.{ts,cts,mts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.strict, tseslint.configs.stylistic],
    rules: {
      "no-undef": "off",
    },
  },
);
