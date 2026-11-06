import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { type ParserOptions, parseSync, Visitor } from "oxc-parser";

type Lang = NonNullable<ParserOptions["lang"]>;

// Bun's js loader accepts JSX, so js parses as jsx.
const DIALECTS = new Map<Bun.Loader, Lang>([
  ["js", "jsx"],
  ["jsx", "jsx"],
  ["ts", "ts"],
  ["tsx", "tsx"],
]);

function metaValues(path: string) {
  return new Map([
    ["url", pathToFileURL(path).href],
    ["path", path],
    ["filename", path],
    ["file", basename(path)],
    ["dir", dirname(path)],
    ["dirname", dirname(path)],
  ]);
}

export function inlineImportMeta(path: string, lang: Lang, source: string) {
  const values = metaValues(path);

  const { program, errors } = parseSync(path, source, {
    lang,
    sourceType: "module",
    // Without this, (import.meta).url wraps the MetaProperty in a ParenthesizedExpression.
    preserveParens: false,
  });

  // Bun parses the untouched source next and reports the syntax error at its real position.
  if (errors.length > 0) {
    return source;
  }

  const edits: { start: number; end: number; text: string }[] = [];

  new Visitor({
    MemberExpression(node) {
      if (
        node.object.type !== "MetaProperty" ||
        node.object.meta.name !== "import" ||
        node.computed ||
        node.property.type !== "Identifier"
      ) {
        return;
      }

      const value = values.get(node.property.name);

      if (value !== undefined) {
        edits.push({ start: node.start, end: node.end, text: JSON.stringify(value) });
      }
    },
  }).visit(program);

  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

// A saved bundle runs from <home>/bundles, so each module's import.meta must keep
// naming the file it was written in. Loopies locate sibling scripts with it. Only the
// parsed `import.meta.<key>` expressions are spliced; every other byte, the loader and
// Bun's own TypeScript handling stay as they were.
//
// Not rewritten: destructuring, computed access such as import.meta["url"], and a
// module imported with { type: "text" } that mentions import.meta, because Bun does
// not tell plugins about import attributes.
export const sourcePaths: Bun.BunPlugin = {
  name: "loopy-source-paths",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path, loader }) => {
      const lang = DIALECTS.get(loader);

      if (lang === undefined) {
        return undefined;
      }

      const source = await Bun.file(path).text();

      // "import" rather than "import.meta": a comment may sit between the tokens.
      if (!source.includes("import")) {
        return undefined;
      }

      return { contents: inlineImportMeta(path, lang, source), loader };
    });
  },
};
