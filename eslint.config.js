import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Globalne ignores (build output, deps, assety, service worker)
  {
    ignores: ["dist", "coverage", "server/node_modules", "public/sw.js", ".claude"],
  },

  // FRONTEND: src/**/*.{ts,tsx}
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended, // nietypowany; tsc -b w CI robi kontrolę typów
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },

  // BACKEND: server/**/*.mjs (Node/ESM, bez React)
  {
    files: ["server/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },

  // Prettier na końcu — wyłącza reguły stylistyczne kolidujące z Prettierem
  eslintConfigPrettier,
);
