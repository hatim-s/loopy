function unsupported(character: string): never {
  throw new Error(
    `Unsupported shell character '${character}'. Pass stdin or use separate commands instead.`,
  );
}

function quotedCharacter(line: string, index: number, quote: string) {
  const character = line.charAt(index);

  if (quote === '"' && character === "\\" && ['"', "\\"].includes(line.charAt(index + 1))) {
    return { text: line.charAt(index + 1), consumed: 2 };
  }

  return { text: character, consumed: 1 };
}

function unquotedCharacter(line: string, index: number) {
  const character = line.charAt(index);

  if (character === "\\") {
    if (index + 1 === line.length) {
      throw new Error(
        "Trailing backslash in command. Add an escaped character or remove the backslash.",
      );
    }

    return { text: line.charAt(index + 1), consumed: 2 };
  }

  if ("|><;&`".includes(character) || line.slice(index, index + 2) === "$(") {
    unsupported(character === "$" ? "$(" : character);
  }

  return { text: character, consumed: 1 };
}

export function parseArgv(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";

  for (let index = 0; index < line.length; index++) {
    const character = line.charAt(index);

    if (quote) {
      if (character === quote) {
        quote = "";
        continue;
      }

      const part = quotedCharacter(line, index, quote);
      word += part.text;
      index += part.consumed - 1;
      continue;
    }

    if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }

      continue;
    }

    started = true;

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    const part = unquotedCharacter(line, index);
    word += part.text;
    index += part.consumed - 1;
  }

  if (quote) {
    throw new Error(`Unterminated ${quote} quote. Close the quote before running the command.`);
  }

  if (started) {
    words.push(word);
  }

  return words;
}
