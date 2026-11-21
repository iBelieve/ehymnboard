import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "worker-configuration.d.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // noUncheckedIndexedAccess makes every buffer[i] possibly undefined;
      // the pixel loops index within bounds and assert with `!`.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["src/client/**/*.tsx"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
);
