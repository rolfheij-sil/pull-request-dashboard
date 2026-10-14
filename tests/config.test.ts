import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const write = (obj: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'prd-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
};

const valid = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};

describe('loadConfig', () => {
  it('loads a valid config', () => {
    expect(loadConfig(write(valid))).toEqual(valid);
  });

  it('leaves scope unset when the config omits it', () => {
    expect(loadConfig(write(valid)).scope).toBeUndefined();
  });

  it.each(['repo', 'org'])('accepts scope "%s"', (scope) => {
    expect(loadConfig(write({ ...valid, scope })).scope).toBe(scope);
  });

  it('rejects an unknown scope, naming the field', () => {
    expect(() => loadConfig(write({ ...valid, scope: 'everything' })))
      .toThrow(/scope/);
  });

  it('leaves quietAfterDays unset when omitted', () => {
    expect(loadConfig(write(valid)).quietAfterDays).toBeUndefined();
  });

  it('accepts a positive quietAfterDays', () => {
    expect(loadConfig(write({ ...valid, quietAfterDays: 14 })).quietAfterDays).toBe(14);
  });

  it.each([0, -3, '30', null])('rejects quietAfterDays %j, naming the field', (quietAfterDays) => {
    expect(() => loadConfig(write({ ...valid, quietAfterDays }))).toThrow(/quietAfterDays/);
  });

  it('names the missing field', () => {
    const { me, ...rest } = valid;
    expect(() => loadConfig(write(rest))).toThrow(/me/);
  });

  it('rejects a poll interval below 30s', () => {
    expect(() => loadConfig(write({ ...valid, pollIntervalMs: 1000 })))
      .toThrow(/pollIntervalMs/);
  });

  it('rejects a value still left as the example placeholder', () => {
    expect(() => loadConfig(write({ ...valid, me: '<your-github-login>' })))
      .toThrow(/me/);
  });

  it('rejects a repoPath that does not exist on disk', () => {
    expect(() => loadConfig(write({ ...valid, repoPath: '/nonexistent/clone' })))
      .toThrow(/repoPath/);
  });

  it('points at the example file when config.json is absent', () => {
    expect(() => loadConfig('/nonexistent/config.json'))
      .toThrow(/config\.example\.json/);
  });

  describe('sessions', () => {
    const sessions = {
      enabled: true,
      claudeCommand: '/usr/bin/claude',
      claudeDir: '~/.claude',
      repoPaths: { 'paranext/paranext-core': '/home/me/core' },
      startPrompt: 'Look at {url} ({title}) by {author} in {repo} #{number}.',
      openTerminalCommand: ['wt.exe', '--title', '{name}', '{claudeCommand}', 'attach', '{id}', '{cwd}', '{sessionId}'],
    };

    it('leaves sessions unset when omitted', () => {
      expect(loadConfig(write(valid)).sessions).toBeUndefined();
    });

    it('accepts a full sessions block unchanged', () => {
      expect(loadConfig(write({ ...valid, sessions })).sessions).toEqual(sessions);
    });

    it('accepts an empty sessions block', () => {
      expect(loadConfig(write({ ...valid, sessions: {} })).sessions).toEqual({});
    });

    it.each([
      ['not an object', 'yes'],
      ['an array', []],
      ['a non-boolean enabled', { enabled: 'yes' }],
      ['an empty claudeCommand', { claudeCommand: '' }],
      ['a non-string claudeDir', { claudeDir: 5 }],
      ['repoPaths as an array', { repoPaths: ['/x'] }],
      ['a non-string repoPaths value', { repoPaths: { 'a/b': 5 } }],
      ['an empty repoPaths value', { repoPaths: { 'a/b': '' } }],
      ['a non-string startPrompt', { startPrompt: 5 }],
      ['openTerminalCommand as a shell string', { openTerminalCommand: 'wt.exe -w 0' }],
      ['an empty openTerminalCommand', { openTerminalCommand: [] }],
      ['a non-string argv element', { openTerminalCommand: ['wt.exe', 5] }],
    ])('rejects sessions with %s, naming the field', (_label, block) => {
      expect(() => loadConfig(write({ ...valid, sessions: block }))).toThrow(/sessions/);
    });

    it('rejects an unknown placeholder in the terminal command, naming it', () => {
      expect(() => loadConfig(write({
        ...valid, sessions: { openTerminalCommand: ['term', '{title}'] },
      }))).toThrow(/\{title\}/);
    });

    it('rejects an unknown placeholder in the start prompt, naming it', () => {
      expect(() => loadConfig(write({
        ...valid, sessions: { startPrompt: 'Look at {cwd}' },
      }))).toThrow(/\{cwd\}/);
    });
  });
});
