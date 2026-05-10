export const MAX_REGEX_PATTERN_CHARS = 512;
const ALLOWED_REGEX_FLAGS = new Set(["i", "m"]);

export type RegexParseResult =
  | { ok: true; pattern: string; flags: string }
  | { ok: false; message: string };

function findClosingSlash(value: string): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "/") {
      return index;
    }
  }
  return -1;
}

function validateFlags(flags: string): string | undefined {
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) {
      return "Regex flags can only include i and m.";
    }
    if (seen.has(flag)) {
      return `Regex flag ${flag} is duplicated.`;
    }
    seen.add(flag);
  }
  return undefined;
}

export function parseWatchRegex(value: string): RegexParseResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, message: "Regex pattern cannot be empty." };
  }

  let pattern = trimmed;
  let flags = "i";
  if (trimmed.startsWith("/")) {
    const closingSlash = findClosingSlash(trimmed);
    if (closingSlash < 0) {
      return { ok: false, message: "Slash-style regex must end with /flags." };
    }
    pattern = trimmed.slice(1, closingSlash);
    flags = trimmed.slice(closingSlash + 1);
    const flagError = validateFlags(flags);
    if (flagError) {
      return { ok: false, message: flagError };
    }
  }

  if (!pattern) {
    return { ok: false, message: "Regex pattern cannot be empty." };
  }
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
    return { ok: false, message: "Regex pattern is too long." };
  }

  try {
    RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Regex pattern is invalid: ${message}` };
  }
  return { ok: true, pattern, flags };
}

export function compileWatchRegex(pattern: string, flags: string): RegExp {
  const flagError = validateFlags(flags);
  if (flagError) {
    throw new Error(flagError);
  }
  if (!pattern) {
    throw new Error("Regex pattern cannot be empty.");
  }
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
    throw new Error("Regex pattern is too long.");
  }
  return new RegExp(pattern, flags);
}
