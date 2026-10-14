import { existsSync, readFileSync } from 'node:fs';
import type { Config } from './types.js';
import {
  PROMPT_PLACEHOLDERS, TERMINAL_PLACEHOLDERS, unknownPlaceholders,
} from './sessions/template.js';

const REQUIRED = [
  'repoPath', 'owner', 'name', 'me',
  'botLogins', 'pollIntervalMs', 'staleAfterHours',
] as const;

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No config at ${path}. Copy config.example.json to config.json and edit it.`,
    );
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (parsed[key] === undefined) throw new Error(`Config is missing "${key}".`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && /^<.+>$/.test(value)) {
      throw new Error(`Config "${key}" is still the example placeholder. Edit ${path}.`);
    }
  }
  if (!existsSync(parsed.repoPath as string)) {
    throw new Error(`Config "repoPath" does not exist: ${String(parsed.repoPath)}.`);
  }
  if ((parsed.pollIntervalMs as number) < 30_000) {
    throw new Error('Config "pollIntervalMs" must be at least 30000 (30s).');
  }
  if (parsed.scope !== undefined && parsed.scope !== 'repo' && parsed.scope !== 'org') {
    throw new Error('Config "scope" must be "repo" or "org".');
  }
  const quiet = parsed.quietAfterDays;
  if (quiet !== undefined && !(typeof quiet === 'number' && Number.isFinite(quiet) && quiet > 0)) {
    throw new Error('Config "quietAfterDays" must be a positive number.');
  }
  if (parsed.sessions !== undefined) validateSessions(parsed.sessions);
  return parsed as unknown as Config;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

function checkPlaceholders(field: string, text: string, allowed: readonly string[]): void {
  const unknown = unknownPlaceholders(text, allowed);
  if (unknown.length > 0) {
    throw new Error(
      `Config "${field}" uses unknown placeholder {${unknown[0]}}. Allowed: ${allowed.map((p) => `{${p}}`).join(' ')}.`,
    );
  }
}

function validateSessions(sessions: unknown): void {
  if (!isObject(sessions)) throw new Error('Config "sessions" must be an object.');
  if (sessions.enabled !== undefined && typeof sessions.enabled !== 'boolean') {
    throw new Error('Config "sessions.enabled" must be true or false.');
  }
  for (const key of ['claudeCommand', 'claudeDir'] as const) {
    if (sessions[key] !== undefined && !isNonEmptyString(sessions[key])) {
      throw new Error(`Config "sessions.${key}" must be a non-empty string.`);
    }
  }
  if (sessions.repoPaths !== undefined) {
    const paths = sessions.repoPaths;
    if (!isObject(paths) || !Object.values(paths).every(isNonEmptyString)) {
      throw new Error('Config "sessions.repoPaths" must map "owner/name" to a path string.');
    }
  }
  if (sessions.startPrompt !== undefined) {
    if (!isNonEmptyString(sessions.startPrompt)) {
      throw new Error('Config "sessions.startPrompt" must be a non-empty string.');
    }
    checkPlaceholders('sessions.startPrompt', sessions.startPrompt, PROMPT_PLACEHOLDERS);
  }
  if (sessions.openTerminalCommand !== undefined) {
    const argv = sessions.openTerminalCommand;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(isNonEmptyString)) {
      throw new Error(
        'Config "sessions.openTerminalCommand" must be a non-empty array of non-empty strings (an argv, not a shell command).',
      );
    }
    for (const element of argv as string[]) {
      checkPlaceholders('sessions.openTerminalCommand', element, TERMINAL_PLACEHOLDERS);
    }
  }
}
