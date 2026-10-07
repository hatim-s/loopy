const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_WORDS = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield".split(
    " ",
  ),
);

/** `--dry-run` becomes `dryRun`; any non-alphanumeric run separates words. */
export function identifier(value: string): string {
  const words = value
    .replace(/^--?/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0]?.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");
}

export function isTypeScriptIdentifier(name: string): boolean {
  return IDENTIFIER_PATTERN.test(name) && !RESERVED_WORDS.has(name);
}
