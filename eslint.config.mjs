import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";
import antiSlopConfig from "./tools/anti-slop/config.mjs";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", ".loopy/**"],
  },
  ...antiSlopConfig,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
    plugins: { unicorn, sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 20],
      "no-useless-concat": "error",
      curly: ["error", "all"],
      "@typescript-eslint/consistent-type-imports": "error",
      "prefer-const": "error",
      "prefer-template": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-lonely-if": "error",
      "no-param-reassign": "error",
      "no-negated-condition": "error",
      "unicorn/prefer-node-protocol": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/array-type": ["error", { default: "array" }],
      "unicorn/filename-case": ["error", { case: "kebabCase", ignore: ["^_tests_$"] }],
      "no-console": "error",
      "no-empty": "error",
      "@typescript-eslint/no-unused-vars": ["error", { args: "all" }],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["packages/loopy/src/cli/**", "scripts/**", "examples/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["packages/loopy/_tests_/**", "examples/**"],
    rules: { "sonarjs/cognitive-complexity": "off", "no-console": "off" },
  },
  {
    files: [
      "packages/loopy/src/core/**",
      "packages/loopy/src/runtime/**",
      "packages/loopy/src/cloud/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["bun", "bun:sqlite", "bun:test"].map((name) => ({
            name,
            message: "Core, runtime and cloud stay portable. Do not use Bun APIs.",
          })),
        },
      ],
    },
  },
);
