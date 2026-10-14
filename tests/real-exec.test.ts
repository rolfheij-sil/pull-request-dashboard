import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultRunner } from '../src/server/routes.js';
import { defaultListDeps } from '../src/sessions/list.js';
import { defaultDetectDeps } from '../src/setup/detect.js';

/**
 * These run the real process launchers (no fakes) against `node`, which writes
 * the arguments it received to a file. If any launcher went through a shell,
 * the metacharacters below would be interpreted instead of arriving verbatim.
 */
const HOSTILE = ['; echo hi', '$(touch X)', '`id`', "it's", '--flag', '& calc', '| more'];

let dir = '';
let outFile = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prd-exec-'));
  outFile = join(dir, 'argv.json');
});

afterEach(() => {
  for (const file of [outFile, join(dir, 'X')]) if (existsSync(file)) unlinkSync(file);
  rmdirSync(dir);
});

const script = 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(1)))';
const args = (): string[] => ['-e', script, outFile, ...HOSTILE];

const received = (): string[] => JSON.parse(readFileSync(outFile, 'utf8')) as string[];

const expectLiteral = (): void => {
  expect(received()).toEqual([outFile, ...HOSTILE]);
  expect(existsSync(join(dir, 'X'))).toBe(false);
  expect(existsSync(join(process.cwd(), 'X'))).toBe(false);
};

const waitForFile = async (): Promise<void> => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      JSON.parse(readFileSync(outFile, 'utf8'));
      return;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  }
  throw new Error('the child never wrote its arguments');
};

describe('real process launchers', () => {
  it('defaultRunner.exec passes every argument literally, in the folder it was given', async () => {
    await defaultRunner.exec(process.execPath, args(), { cwd: dir, timeout: 10_000 });
    expectLiteral();
  });

  it('defaultRunner.spawnDetached passes every argument literally', async () => {
    await defaultRunner.spawnDetached(process.execPath, args());
    await waitForFile();
    expectLiteral();
  });

  it('defaultRunner.spawnDetached rejects when the program does not exist', async () => {
    await expect(defaultRunner.spawnDetached(join(dir, 'no-such-program'), []))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('defaultListDeps.exec passes every argument literally', async () => {
    await defaultListDeps.exec(process.execPath, args(), { timeout: 10_000 });
    expectLiteral();
  });

  it('defaultDetectDeps.exec passes every argument literally', async () => {
    await defaultDetectDeps.exec(process.execPath, args(), { timeout: 10_000 });
    expectLiteral();
  });
});
