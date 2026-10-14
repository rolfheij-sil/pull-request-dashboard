import { describe, expect, it } from 'vitest';
import { DEFAULT_START_PROMPT } from '../src/sessions/start.js';
import type { SessionInfo } from '../src/sessions/types.js';
import type { DetectedSetup } from '../src/setup/detect.js';
import { effectiveSessionsConfig, loadSaved, writeSaved } from '../src/setup/settings.js';
import { openStore } from '../src/store/db.js';

const detected = (over: Partial<DetectedSetup> = {}): DetectedSetup => ({
  platform: 'linux',
  wslDistro: null,
  claude: { path: '/usr/bin/claude', version: '2.1', reason: null },
  terminals: [
    { id: 'first', label: 'First', argv: ['first', '{id}'] },
    { id: 'second', label: 'Second', argv: ['second', '{id}'] },
  ],
  desktopResume: false,
  repoClones: { 'o/a': ['/clones/a1', '/clones/a2'], 'o/b': ['/clones/b'] },
  ...over,
});

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'x', sessionId: 's', name: 'n', kind: 'background', status: 'busy', state: 'working',
  cwd: '/', startedAt: 1, branch: null, repo: null, prLinks: [], intent: '', claudeAiUrl: null, ...over,
});

describe('effectiveSessionsConfig: terminal', () => {
  it('uses config.json first, whatever the panel saved', () => {
    const effective = effectiveSessionsConfig(
      { openTerminalCommand: ['mine', '{id}'] }, detected(), { terminalPreset: 'second' },
    );
    expect(effective.sessions.openTerminalCommand).toEqual(['mine', '{id}']);
    expect(effective.openTerminalSource).toBe('config');
    expect(effective.terminalPreset).toBeNull();
    expect(effective.lockedByConfig).toContain('terminalPreset');
  });

  it('uses the saved preset over detection', () => {
    const effective = effectiveSessionsConfig(undefined, detected(), { terminalPreset: 'second' });
    expect(effective.sessions.openTerminalCommand).toEqual(['second', '{id}']);
    expect(effective.openTerminalSource).toBe('panel');
    expect(effective.terminalPreset).toBe('second');
  });

  it('falls back to the first detected preset when the saved id is not detected', () => {
    const effective = effectiveSessionsConfig(undefined, detected(), { terminalPreset: 'gone' });
    expect(effective.terminalPreset).toBe('first');
    expect(effective.openTerminalSource).toBe('detected');
  });

  it('uses the first detected preset by default, and none when nothing is detected', () => {
    expect(effectiveSessionsConfig(undefined, detected(), {}).sessions.openTerminalCommand)
      .toEqual(['first', '{id}']);
    const none = effectiveSessionsConfig(undefined, detected({ terminals: [] }), { terminalPreset: 'first' });
    expect(none.sessions.openTerminalCommand).toBeUndefined();
    expect(none.openTerminalSource).toBe('none');
  });
});

describe('effectiveSessionsConfig: repoPaths and prompt', () => {
  it('layers config.json over saved over detected, per repo, ignoring key case', () => {
    const effective = effectiveSessionsConfig(
      { repoPaths: { 'O/A': '/config/a' } },
      detected({ repoClones: { 'o/a': ['/d/a'], 'o/b': ['/d/b'], 'o/c': ['/d/c'] } }),
      { repoPaths: { 'o/a': '/saved/a', 'o/b': '/saved/b' } },
    );
    expect(effective.repoPaths).toEqual({ 'o/a': '/config/a', 'o/b': '/saved/b', 'o/c': '/d/c' });
    expect(effective.sessions.repoPaths).toEqual(effective.repoPaths);
    expect(effective.lockedByConfig).toContain('repoPaths.o/a');
    expect(effective.lockedByConfig).not.toContain('repoPaths.o/b');
  });

  it('takes the first detected candidate', () => {
    expect(effectiveSessionsConfig(undefined, detected(), {}).repoPaths['o/a']).toBe('/clones/a1');
  });

  it('layers the start prompt config.json > saved > default', () => {
    expect(effectiveSessionsConfig({ startPrompt: 'C' }, detected(), { startPrompt: 'S' }).startPrompt).toBe('C');
    expect(effectiveSessionsConfig({ startPrompt: 'C' }, detected(), {}).lockedByConfig).toContain('startPrompt');
    expect(effectiveSessionsConfig(undefined, detected(), { startPrompt: 'S' }).startPrompt).toBe('S');
    expect(effectiveSessionsConfig(undefined, detected(), {}).startPrompt).toBe(DEFAULT_START_PROMPT);
  });
});

describe('effectiveSessionsConfig: primary action', () => {
  it('prefers the saved action', () => {
    expect(effectiveSessionsConfig(undefined, detected(), { primaryAction: 'copy' }).primaryAction).toBe('copy');
  });

  it('ignores a saved desktop action where the desktop app is unavailable', () => {
    const off = effectiveSessionsConfig(undefined, detected(), { primaryAction: 'desktop' });
    expect(off.primaryAction).toBe('terminal');
    const on = effectiveSessionsConfig(
      undefined, detected({ platform: 'darwin', desktopResume: true }), { primaryAction: 'desktop' },
    );
    expect(on.primaryAction).toBe('desktop');
  });

  it('defaults to claude.ai when most live sessions have a link', () => {
    const live = [
      session({ claudeAiUrl: 'u' }), session({ claudeAiUrl: 'u' }), session(),
      session({ status: null, claudeAiUrl: null }),
    ];
    expect(effectiveSessionsConfig(undefined, detected(), {}, live).primaryAction).toBe('claudeAi');
  });

  it('defaults to a terminal when few live sessions have a link, else to copy', () => {
    const live = [session({ claudeAiUrl: 'u' }), session(), session()];
    expect(effectiveSessionsConfig(undefined, detected(), {}, live).primaryAction).toBe('terminal');
    expect(effectiveSessionsConfig(undefined, detected({ terminals: [] }), {}, live).primaryAction).toBe('copy');
    expect(effectiveSessionsConfig({ openTerminalCommand: ['t'] }, detected({ terminals: [] }), {}).primaryAction)
      .toBe('terminal');
  });
});

describe('effectiveSessionsConfig: enabled and CLI', () => {
  it('is on when the CLI is detected and off when it is not', () => {
    expect(effectiveSessionsConfig(undefined, detected(), {}).sessions.enabled).toBe(true);
    const missing = detected({ claude: { path: null, version: null, reason: 'x' } });
    expect(effectiveSessionsConfig(undefined, missing, {}).sessions.enabled).toBe(false);
  });

  it('lets config.json turn it off or on', () => {
    expect(effectiveSessionsConfig({ enabled: false }, detected(), {}).sessions.enabled).toBe(false);
    const missing = detected({ claude: { path: null, version: null, reason: 'x' } });
    expect(effectiveSessionsConfig({ enabled: true }, missing, {}).sessions.enabled).toBe(true);
  });

  it('runs the detected CLI path unless config.json names one', () => {
    expect(effectiveSessionsConfig(undefined, detected(), {}).sessions.claudeCommand).toBe('/usr/bin/claude');
    expect(effectiveSessionsConfig({ claudeCommand: 'c' }, detected(), {}).sessions.claudeCommand).toBe('c');
  });
});

describe('saved settings', () => {
  it('round-trips through the store and survives reopening it', () => {
    const store = openStore(':memory:', 'o/a');
    writeSaved(store, { primaryAction: 'copy', terminalPreset: 'second', repoPaths: { 'o/a': '/x' }, startPrompt: 'P' });
    expect(loadSaved(store)).toEqual({
      primaryAction: 'copy', terminalPreset: 'second', repoPaths: { 'o/a': '/x' }, startPrompt: 'P',
    });
  });

  it('forgets a field saved as empty or null, and drops values of the wrong shape', () => {
    const store = openStore(':memory:', 'o/a');
    writeSaved(store, { primaryAction: 'copy', terminalPreset: 'second', repoPaths: { 'o/a': '/x' }, startPrompt: 'P' });
    writeSaved(store, { terminalPreset: null as unknown as undefined, repoPaths: {}, startPrompt: '' });
    expect(loadSaved(store)).toEqual({ primaryAction: 'copy' });
    store.setSetting('primaryAction', 'teleport');
    store.setSetting('repoPaths', ['x']);
    expect(loadSaved(store)).toEqual({});
  });
});
