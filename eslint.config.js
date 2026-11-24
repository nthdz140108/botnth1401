import importPlugin from "eslint-plugin-import";
import globals from "globals";

const nodeGlobals = {
  ...globals.es2024,
  ...globals.node,
  ...globals.nodeBuiltin,
};

const browserGlobals = {
  ...globals.es2024,
  ...globals.browser,
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/logs/**",
      "**/tests/**",
      "dashboard/dist/**",
      "dashboard/public/**",
    ],
  },
  {
    files: ["*.js", "src/**/*.js", "scripts/**/*.js", "dashboard/server.js"],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    settings: {
      "import/resolver": {
        node: {
          extensions: [".js", ".jsx", ".mjs", ".cjs"],
        },
      },
    },
    rules: {
      "import/no-unresolved": ["error", { caseSensitive: true, ignore: ["^p-queue$"] }],
      "no-undef": "error",
    },
  },
  {
    files: ["dashboard/src/**/*.{js,jsx}"],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      "import/resolver": {
        node: {
          extensions: [".js", ".jsx", ".mjs", ".cjs"],
        },
      },
    },
    rules: {
      "import/no-unresolved": ["error", { caseSensitive: true, ignore: ["^p-queue$"] }],
      "no-undef": "error",
    },
  },
];
