/**
 * Runs .github/scripts/find-core-release.sh against throwaway git repos (an "upstream" with x.y.z tags and a clone
 * standing in for the submodule). Pins the event-driven sync: a release tag sent with repository_dispatch is preferred
 * only when it is a valid x.y.z tag that is also the newest upstream release; anything else falls back to the newest
 * release found by the script itself. Paths are relative to app/.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve('../.github/scripts/find-core-release.sh');

/** Git for Windows' bash (System32\bash.exe is WSL and must not be used); plain `bash` elsewhere. */
function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    // <Git>/mingw64/libexec/git-core -> <Git>/bin/bash.exe
    const candidate = join(dirname(dirname(dirname(exec))), 'bin', 'bash.exe');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const BASH = findBash();
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

let root = '';
let upstream = '';
let sub = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

function release(tag: string) {
  git(upstream, 'commit', '--quiet', '--allow-empty', '-m', `release ${tag}`);
  git(upstream, 'tag', tag);
}

function run(requested?: string) {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV, FIND_CORE_RETRY_SLEEP: '0' };
  delete env.REQUESTED_TAG;
  if (requested !== undefined) env.REQUESTED_TAG = requested;
  const r = spawnSync(BASH!, [SCRIPT, sub], { encoding: 'utf8', env });
  const out: Record<string, string> = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\w+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!BASH)('find-core-release.sh', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'find-core-'));
    upstream = join(root, 'upstream');
    sub = join(root, 'sub');
    execFileSync('git', ['init', '--quiet', upstream], { env: GIT_ENV });
    release('1.0.0');
    release('1.1.0');
    git(upstream, 'tag', 'v9.9.9-beta'); // not a release tag
    release('1.2.0');
    execFileSync('git', ['clone', '--quiet', upstream, sub], { env: GIT_ENV });
    git(sub, 'checkout', '--quiet', '1.0.0');
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('without a requested tag, picks the newest x.y.z release (schedule and manual runs)', () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ current: '1.0.0', latest: '1.2.0', behind: 'true', requested: '' });
  });

  it('an empty requested tag counts as none', () => {
    const r = run('');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.latest).toBe('1.2.0');
    expect(r.out.requested).toBe('');
    expect(r.stderr).not.toMatch(/::warning::|::notice::/);
  });

  it('uses a requested tag that is the newest release', () => {
    const r = run('1.2.0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ current: '1.0.0', latest: '1.2.0', behind: 'true', requested: '1.2.0' });
    expect(r.stderr).not.toMatch(/::warning::/);
  });

  it('accepts surrounding whitespace in the requested tag', () => {
    const r = run(' 1.2.0\n');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.requested).toBe('1.2.0');
  });

  it('a requested tag that is not the newest release yields to the newest, with a notice', () => {
    const r = run('1.1.0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.latest).toBe('1.2.0');
    expect(r.out.requested).toBe('1.1.0');
    expect(r.stderr).toMatch(/::notice::.*1\.1\.0.*1\.2\.0/);
  });

  it.each(['v1.2.0', '1.2', '1.2.0-rc.1', '01.2.0', '1.2.0; echo latest=6.6.6', '$(echo 6.6.6)', '1.2.0\nlatest=6.6.6'])(
    'ignores a malformed requested tag (%j) with a warning and never echoes it into the outputs',
    (bad) => {
      const r = run(bad);
      expect(r.status, r.stderr).toBe(0);
      expect(r.out.latest).toBe('1.2.0');
      expect(r.out.requested).toBe('');
      expect(r.stdout).not.toMatch(/6\.6\.6/);
      expect(r.stderr).toMatch(/::warning::.*not a valid x\.y\.z/);
    },
  );

  it('a requested tag missing upstream (after retries) falls back to the newest release, with a warning', () => {
    const r = run('7.0.0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.latest).toBe('1.2.0');
    expect(r.out.requested).toBe('7.0.0');
    expect(r.stderr).toMatch(/::warning::.*7\.0\.0.*not found/);
  });

  it('fetches a release published after the clone and moves to it', () => {
    release('1.3.0');
    const r = run('1.3.0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ current: '1.0.0', latest: '1.3.0', behind: 'true', requested: '1.3.0' });
  });

  it('is not behind once the core is on the newest release', () => {
    git(sub, 'checkout', '--quiet', '1.3.0');
    const r = run('1.3.0');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ current: '1.3.0', latest: '1.3.0', behind: 'false', requested: '1.3.0' });
  });
});
