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
