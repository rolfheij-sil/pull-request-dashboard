import type { Store } from '../store/db.js';
import { isGithubName } from '../server/params.js';
import { PROMPT_PLACEHOLDERS, unknownPlaceholders } from '../sessions/template.js';
import type { SessionInfo } from '../sessions/types.js';
import type { SessionsConfig } from '../types.js';
import {
  checkRepoFolder, defaultDetectDeps, detectSetup, type DetectDeps, type DetectedSetup,
} from './detect.js';
import {
  effectiveSessionsConfig, loadSaved, PRIMARY_ACTIONS, writeSaved,
  type EffectiveSetup, type SavedSettings,
} from './settings.js';

export const START_PROMPT_MAX_CHARS = 2_000;

/** The only fields the panel may save. Commands and argv are deliberately not among them. */
const SAVABLE = ['primaryAction', 'terminalPreset', 'repoPaths', 'startPrompt'] as const;

export type SaveResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string> };

export interface SetupService {
  detected(): DetectedSetup;
  /** Detects again, including the folders live sessions are running in. */
  redetect(): Promise<void>;
  saved(): SavedSettings;
  effective(): EffectiveSetup;
  /** Validates and saves panel choices; saves nothing when any field is invalid. */
  save(body: unknown): Promise<SaveResult>;
}

export interface SetupOptions {
  /** The raw `sessions` block of config.json; it overrides detection and the panel. */
  configSessions: SessionsConfig | undefined;
  /** The home repo's clone; clone discovery starts from it. */
  repoPath: string;
  store: Store;
  /** The live sessions, for clone discovery and the default primary action. */
  liveSessions?: () => readonly SessionInfo[];
  deps?: DetectDeps;
}

const emptyDetection = (deps: DetectDeps): DetectedSetup => ({
  platform: deps.platform === 'darwin' || deps.platform === 'win32' ? deps.platform : 'linux',
  wslDistro: null,
  claude: { path: null, version: null, reason: 'not detected yet', candidates: [] },
  terminals: [],
  desktopResume: false,
  repoClones: {},
});

export function createSetupService(options: SetupOptions): SetupService {
  const deps = options.deps ?? defaultDetectDeps;
  const { store, configSessions } = options;
  const liveSessions = options.liveSessions ?? (() => []);
  let detected = emptyDetection(deps);

  const effective = (): EffectiveSetup =>
    effectiveSessionsConfig(configSessions, detected, loadSaved(store), liveSessions());

  return {
    detected: () => detected,
    async redetect() {
      detected = await detectSetup(deps, {
        repoPath: options.repoPath,
        sessionCwds: [...new Set(liveSessions().map((s) => s.cwd))],
      });
    },
    saved: () => loadSaved(store),
    effective,

    async save(body) {
      const errors: Record<string, string> = {};
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { ok: false, errors: { body: 'expected a JSON object' } };
      }
      const patch = body as Record<string, unknown>;
      for (const key of Object.keys(patch)) {
        if (!(SAVABLE as readonly string[]).includes(key)) {
          errors[key] = 'is not a setting the panel can change';
        }
      }

      const locked = new Set(effective().lockedByConfig);
      const accepted: Record<string, unknown> = {};

      if ('primaryAction' in patch) {
        const value = patch.primaryAction;
        if (typeof value !== 'string' || !(PRIMARY_ACTIONS as readonly string[]).includes(value)) {
          errors.primaryAction = `must be one of ${PRIMARY_ACTIONS.join(', ')}`;
        } else if (value === 'desktop' && !detected.desktopResume) {
          errors.primaryAction = 'the desktop app is not available on this machine';
        } else {
          accepted.primaryAction = value;
        }
      }

      if ('terminalPreset' in patch) {
        const value = patch.terminalPreset;
        if (locked.has('terminalPreset')) {
          errors.terminalPreset = 'is set in config.json';
        } else if (value === null) {
          accepted.terminalPreset = null;
        } else if (typeof value !== 'string' || !detected.terminals.some((t) => t.id === value)) {
          errors.terminalPreset = 'must be one of the detected terminals';
        } else {
          accepted.terminalPreset = value;
        }
      }

      if ('startPrompt' in patch) {
        const value = patch.startPrompt;
        if (locked.has('startPrompt')) {
          errors.startPrompt = 'is set in config.json';
        } else if (typeof value !== 'string') {
          errors.startPrompt = 'must be text';
        } else if (value.length > START_PROMPT_MAX_CHARS) {
          errors.startPrompt = `must be at most ${START_PROMPT_MAX_CHARS} characters`;
        } else {
          const unknown = unknownPlaceholders(value, PROMPT_PLACEHOLDERS);
          if (unknown.length > 0) {
            errors.startPrompt = `uses unknown placeholder {${unknown[0]}}`;
          } else {
            accepted.startPrompt = value;
          }
        }
      }

      if ('repoPaths' in patch) {
        const value = patch.repoPaths;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          errors.repoPaths = 'must map "owner/name" to a folder';
        } else {
          const kept: Record<string, string> = {};
          await Promise.all(Object.entries(value).map(async ([repo, folder]) => {
            const field = `repoPaths.${repo}`;
            const [owner, name, ...rest] = repo.split('/');
            if (
              owner === undefined || name === undefined || rest.length > 0
              || !isGithubName(owner) || !isGithubName(name)
            ) {
              errors[field] = 'must be written owner/name';
            } else if (locked.has(`repoPaths.${repo.toLowerCase()}`)) {
              errors[field] = 'is set in config.json';
            } else if (typeof folder !== 'string') {
              errors[field] = 'must be a folder path';
            } else if (folder === '') {
              // An empty folder forgets the saved choice.
            } else {
              const problem = await checkRepoFolder(deps, repo, folder);
              if (problem === null) kept[repo.toLowerCase()] = folder;
              else errors[field] = problem;
            }
          }));
          accepted.repoPaths = kept;
        }
      }

      if (Object.keys(errors).length > 0) return { ok: false, errors };
      writeSaved(store, accepted);
      return { ok: true };
    },
  };
}
