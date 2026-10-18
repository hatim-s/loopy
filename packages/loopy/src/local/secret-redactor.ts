export const REDACTED = "[redacted]";

/** Longest prefix of any secret that the text ends with, so a cut-off secret still hides. */
function trailingSecretPrefix(text: string, secrets: string[]): number {
  let boundary = 0;

  for (const secret of secrets) {
    for (let length = Math.min(secret.length, text.length); length > boundary; length--) {
      if (text.endsWith(secret.slice(0, length))) {
        boundary = length;
        break;
      }
    }
  }

  return boundary;
}

const escape = (value: string) => JSON.stringify(value).slice(1, -1);

/**
 * Exact values are masked. Raw output can carry a secret JSON-escaped once (a log record) or twice
 * (serialized JSON inside a record), so both forms count. Truncated output also masks a secret
 * prefix at the stream boundary.
 */
export function secretRedactor(values: string[]) {
  const secrets = [
    ...new Set(values.flatMap((value) => [value, escape(value), escape(escape(value))])),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const pattern = secrets.length
    ? new RegExp(
        secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "g",
      )
    : undefined;

  return (text: string, truncated = false): string => {
    const boundary = truncated ? trailingSecretPrefix(text, secrets) : 0;
    const masked = boundary ? `${text.slice(0, -boundary)}${REDACTED}` : text;

    return pattern ? masked.replace(pattern, REDACTED) : masked;
  };
}
