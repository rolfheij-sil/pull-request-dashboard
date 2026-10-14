import type { Store } from '../store/db.js';
import { DEFAULT_START_PROMPT } from '../sessions/start.js';
import type { PrimaryAction, SessionInfo } from '../sessions/types.js';
import type { SessionsConfig } from '../types.js';
import type { DetectedSetup } from './detect.js';

export const PRIMARY_ACTIONS: readonly PrimaryAction[] = ['claudeAi', 'terminal', 'desktop', 'copy'];

/** What the settings panel saves. Every field is optional: unset means "use the detected default". */
export interface SavedSettings {
  primaryAction?: PrimaryAction;
  terminalPreset?: string;
  /** Lowercased `owner/name` to an absolute clone folder. */
  repoPaths?: Record<string, string>;
  startPrompt?: string;
}

export type OpenTerminalSource = 'config' | 'panel' | 'detected' | 'none';

/** What the server actually uses, after config.json > panel > detection. */
export interface EffectiveSetup {
  /** The resolved sessions configuration the listing, routes and board run on. */
  sessions: SessionsConfig;
  primaryAction: PrimaryAction;
  /** The detected preset in use; null when config.json supplies the command or there is none. */
  terminalPreset: string | null;
  repoPaths: Record<string, string>;
  startPrompt: string;
  openTerminalSource: OpenTerminalSource;
  desktopResume: boolean;
  /** Fields config.json sets, which the panel shows read-only: `terminalPreset`, `startPrompt`, `repoPaths.<owner/name>`. */
  lockedByConfig: string[];
}

const SETTING_KEYS = ['primaryAction', 'terminalPreset', 'repoPaths', 'startPrompt'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the saved settings, dropping anything that has the wrong shape. */
export function loadSaved(store: Store): SavedSettings {
  const saved: SavedSettings = {};
  const primary = store.getSetting('primaryAction');
  if (typeof primary === 'string' && (PRIMARY_ACTIONS as readonly string[]).includes(primary)) {
    saved.primaryAction = primary as PrimaryAction;
  }
  const preset = store.getSetting('terminalPreset');
  if (typeof preset === 'string' && preset !== '') saved.terminalPreset = preset;
  const paths = store.getSetting('repoPaths');
  if (isObject(paths)) {
    const clean: Record<string, string> = {};
    for (const [repo, folder] of Object.entries(paths)) {
      if (typeof folder === 'string' && folder !== '') clean[repo.toLowerCase()] = folder;
    }
    saved.repoPaths = clean;
  }
  const prompt = store.getSetting('startPrompt');
  if (typeof prompt === 'string' && prompt !== '') saved.startPrompt = prompt;
  return saved;
}

/** Stores `patch`; a key set to null or an empty value is forgotten. */
export function writeSaved(store: Store, patch: SavedSettings & Record<string, unknown>): void {
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    const empty = value === undefined || value === null || value === ''
      || (isObject(value) && Object.keys(value).length === 0);
    if (empty) store.deleteSetting(key);
    else store.setSetting(key, value);
  }
}

const lowerKeys = (paths: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(paths ?? {}).map(([repo, folder]) => [repo.toLowerCase(), folder]));

/**
 * Resolves the settings the server runs on. Precedence for every field is
 * config.json, then the panel's saved choice, then what was detected.
 */
export function effectiveSessionsConfig(
  configFile: SessionsConfig | undefined,
  detected: DetectedSetup,
  saved: SavedSettings,
  liveSessions: readonly SessionInfo[] = [],
): EffectiveSetup {
  const config = configFile ?? {};
  const lockedByConfig: string[] = [];

  let terminalPreset: string | null = null;
  let openTerminalCommand: string[] | undefined;
  let openTerminalSource: OpenTerminalSource = 'none';
  if (config.openTerminalCommand !== undefined) {
    openTerminalCommand = config.openTerminalCommand;
    openTerminalSource = 'config';
    lockedByConfig.push('terminalPreset');
  } else {
    const savedPreset = detected.terminals.find((t) => t.id === saved.terminalPreset);
    const preset = savedPreset ?? detected.terminals[0];
    if (preset !== undefined) {
      terminalPreset = preset.id;
      openTerminalCommand = preset.argv;
      openTerminalSource = savedPreset !== undefined ? 'panel' : 'detected';
    }
  }

  const repoPaths: Record<string, string> = {};
  for (const [repo, candidates] of Object.entries(detected.repoClones)) {
    if (candidates[0] !== undefined) repoPaths[repo.toLowerCase()] = candidates[0];
  }
  Object.assign(repoPaths, lowerKeys(saved.repoPaths));
  const fromConfig = lowerKeys(config.repoPaths);
  Object.assign(repoPaths, fromConfig);
  for (const repo of Object.keys(fromConfig)) lockedByConfig.push(`repoPaths.${repo}`);

  let startPrompt = saved.startPrompt ?? DEFAULT_START_PROMPT;
  if (config.startPrompt !== undefined) {
    startPrompt = config.startPrompt;
    lockedByConfig.push('startPrompt');
  }

  const desktopResume = detected.desktopResume;
  const savedPrimary = saved.primaryAction === 'desktop' && !desktopResume
    ? undefined : saved.primaryAction;
  const live = liveSessions.filter((s) => s.status !== null);
  const mostHaveClaudeAi = live.length > 0
    && live.filter((s) => s.claudeAiUrl !== null).length * 2 > live.length;
  const primaryAction: PrimaryAction = savedPrimary
    ?? (mostHaveClaudeAi ? 'claudeAi' : openTerminalCommand !== undefined ? 'terminal' : 'copy');

  const sessions: SessionsConfig = {
    enabled: config.enabled ?? detected.claude.path !== null,
    claudeCommand: config.claudeCommand ?? detected.claude.path ?? 'claude',
    claudeDir: config.claudeDir,
    repoPaths,
    startPrompt,
    openTerminalCommand,
  };

  return {
    sessions, primaryAction, terminalPreset, repoPaths, startPrompt,
    openTerminalSource, desktopResume, lockedByConfig,
  };
}
