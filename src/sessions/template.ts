const PLACEHOLDER = /\{([^{}]*)\}/g;

export const TERMINAL_PLACEHOLDERS = ['id', 'sessionId', 'cwd', 'name', 'claudeCommand'] as const;
export const PROMPT_PLACEHOLDERS = ['url', 'title', 'repo', 'number', 'author'] as const;

/** Placeholder names used in `template` that are not in `allowed`. */
export function unknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!allowed.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/**
 * Plain string substitution of known placeholders in a single pass, so a
 * substituted value that itself contains `{x}` is never expanded again.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole);
}

/** Single-quotes `value` for a POSIX shell, escaping any single quote inside it. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** True when `program` is Windows Terminal's launcher (`wt` or `wt.exe`, in any folder and case). */
export function isWindowsTerminal(program: string): boolean {
  const base = program.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return base === 'wt' || base === 'wt.exe';
}

/**
 * Fills every element of a command template. Windows Terminal reads an
 * unescaped `;` anywhere in its arguments as the separator between its own
 * subcommands, so for `wt`/`wt.exe` each `;` in a substituted value is written
 * `\;`. Literal template text is left alone.
 */
export function fillArgv(argv: readonly string[], values: Record<string, string>): string[] {
  const program = fillTemplate(argv[0] ?? '', values);
  const safe = isWindowsTerminal(program)
    ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replaceAll(';', '\\;')]))
    : values;
  return argv.map((element) => fillTemplate(element, safe));
}
