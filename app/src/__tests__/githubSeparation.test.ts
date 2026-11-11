/**
 * GitHub upload separation guards (plan Task 15, spec §11). The GitHub token and its commands stay inside the GitHub feature:
 * the updater, the skin gallery, the MCP server, the experiment AI context, the assistant and the SKILL.md text never name a
 * `github_` command, the `'github'` keychain slots, `githubIpc` or the GitHub status store; and outside `githubIpc.ts` no
 * source calls a `github_` command by name. Paths are relative to app/.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..', '..');

/** Every source file under `dir` (relative to app/), tests included; [] when the folder does not exist (yet). */
function filesUnder(dir: string, exts = ['.ts', '.tsx', '.rs', '.md']): string[] {
  const root = join(APP, dir);
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [dir];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((e) => name.endsWith(e))) out.push(relative(APP, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

const isTest = (path: string) => /(^|\/)__tests__\//.test(path) || /\.test\.tsx?$/.test(path);
const read = (path: string) => readFileSync(join(APP, path), 'utf8');
/** `text` without block and line comments (doc comments may name a command in backticks; only code counts). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A quoted `github_…` command name (any quote). */
const COMMAND_STRING = /['"`]github_[a-z0-9_]+['"`]/;

/** What the updater and skin code must not mention: GitHub keychain slots, GitHub commands, the GitHub IPC module. */
function updaterViolations(text: string): string[] {
  const hits: string[] = [];
  if (/['"`](github|githubRefresh)['"`]/.test(text)) hits.push('github slot');
  if (/github_/.test(text)) hits.push('github_ command');
  if (/githubIpc/.test(text)) hits.push('githubIpc');
  return hits;
}

/** What the MCP / assistant / SKILL.md code must not mention (spec §11). */
function assistantViolations(text: string): string[] {
  const hits: string[] = [];
  if (/github_/.test(text)) hits.push('github_');
  if (/githubIpc/.test(text)) hits.push('githubIpc');
  if (/github\/statusStore/.test(text)) hits.push('github/statusStore');
  return hits;
}

describe('the guards catch what they are meant to catch', () => {
  it('flags a fixture that breaks each rule', () => {
    expect(updaterViolations(`await setSecret(invoke, 'github', v);`)).toEqual(['github slot']);
    expect(updaterViolations(`invoke('github_upload', {})`)).toContain('github_ command');
    expect(updaterViolations(`import { account } from '../integrations/githubIpc';`)).toEqual(['githubIpc']);
    expect(updaterViolations(`const url = 'https://github.com/owner/repo/releases';`)).toEqual([]);
    expect(assistantViolations(`import { useStatus } from '../../github/statusStore';`)).toEqual(['github/statusStore']);
    expect(assistantViolations(`tool: 'github_plan'`)).toEqual(['github_']);
    expect(assistantViolations(`Use labnoteO to write notes.`)).toEqual([]);
    expect(COMMAND_STRING.test(`invoke("github_sign_out")`)).toBe(true);
    expect(COMMAND_STRING.test(`const label = 'GitHub';`)).toBe(false);
    expect(COMMAND_STRING.test(code(['/** calls `github_retry` */', 'const x = 1; // `github_plan`'].join('\n')))).toBe(false);
    expect(COMMAND_STRING.test(code('invoke(`github_plan`, {}); // ok'))).toBe(true);
  });
});

describe('the updater and skin gallery never touch the GitHub token', () => {
  const files = [...filesUnder('src/update'), ...filesUnder('src').filter((p) => /(^|\/)[^/]*skin[^/]*$/i.test(p) || /\/skins?\//i.test(p))]
    .filter((p) => !isTest(p));

  it('finds the updater sources', () => {
    for (const f of ['src/update/UpdateButton.tsx', 'src/update/checkCommand.ts', 'src/update/updateStore.ts']) {
      expect(files).toContain(f);
    }
  });

  it.each(files)('%s names no GitHub slot, command or IPC', (path) => {
    expect(updaterViolations(read(path))).toEqual([]);
  });
});

describe('only githubIpc.ts calls a github_ command by name', () => {
  it('no other source file holds a quoted github_ command', () => {
    const offenders = filesUnder('src', ['.ts', '.tsx'])
      .filter((p) => !isTest(p) && p !== 'src/integrations/githubIpc.ts')
      .filter((p) => COMMAND_STRING.test(code(read(p))));
    expect(offenders).toEqual([]);
  });
});

describe('MCP, AI context, assistant and SKILL.md stay out of GitHub (spec §11)', () => {
  const dirs = [
    'src/labnote/mcp',
    'src/labnote/context',
    'src/ai',
    'src/labnote/skill',
    'src-tauri/src/mcp',
    'src-tauri/src/skill.rs',
    'src-tauri/resources/skills',
  ];

  it('every guarded location exists', () => {
    for (const d of dirs) expect(existsSync(join(APP, d)), d).toBe(true);
  });

  const files = dirs.flatMap((d) => filesUnder(d)).filter((p) => !isTest(p));
  it.each(files)('%s has no github_, githubIpc or github/statusStore', (path) => {
    expect(assistantViolations(read(path))).toEqual([]);
  });
});
