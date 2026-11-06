import { dirname, relative, resolve } from "node:path";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";
import antiSlopConfig from "./tools/anti-slop/config.mjs";

const relativeInternalImports = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      alias: "Use relative imports within a package and explicit @loopy exports across packages.",
      extension: "Internal imports must omit code extensions and the index filename.",
      boundary: "Cross-package imports must use explicit workspace package exports.",
    },
  },
  create(context) {
    function check(source) {
      if (source?.type !== "Literal" || !['"', "'"].includes(source.raw?.[0])) {
        return;
      }

      const value = source.value;

      const filename = context.filename;
      const packageRoot = /^(.*\/packages\/[^/]+)\/src\//.exec(filename)?.[1];

      if (packageRoot && value.startsWith(".")) {
        const target = relative(packageRoot, resolve(dirname(filename), value));

        if (target === ".." || target.startsWith("../")) {
          context.report({ node: source, messageId: "boundary" });
        }
      }

      const authorSource = /\/(?:_tests_|examples)\//.test(filename);

      if (
        (!authorSource && (value === "loopy" || value.startsWith("loopy/"))) ||
        value.startsWith("@/")
      ) {
        context.report({ node: source, messageId: "alias" });
      } else if (
        value.startsWith(".") &&
        (/\.(?:[jt]sx?)(?:[?#].*)?$/.test(value) || /(?:^|\/)index(?:[?#].*)?$/.test(value))
      ) {
        context.report({ node: source, messageId: "extension" });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "coverage/**",
      "research/**",
      ".notes/**",
      ".loopy/**",
      "**/routeTree.gen.ts",
    ],
  },
  ...antiSlopConfig,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
    plugins: {
      unicorn,
      sonarjs,
      internal: { rules: { "relative-imports": relativeInternalImports } },
    },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 20],
      "internal/relative-imports": "error",
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
    ignores: ["examples/**"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["packages/cli/src/**", "scripts/**", "apps/cloud/dev/**", "examples/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["packages/loopy/_tests_/**", "examples/**"],
    rules: { "sonarjs/cognitive-complexity": "off", "no-console": "off" },
  },
  {
    files: ["packages/core/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["bun", "bun:sqlite", "bun:test"].map((name) => ({
            name,
            message: "Core and runtime stay portable. Do not use Bun APIs.",
          })),
        },
      ],
    },
  },
);
