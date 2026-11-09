/**
 * Runs .github/scripts/release-state.sh with a fake `gh` first on PATH. Pins how both workflows read a release: a release
 * counts only with latest.json, the installer and its .sig (releaseChain.mjs release-state), "release not found" is
 * state=none, and any other gh error fails closed. Paths are relative to app/.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve('../.github/scripts/release-state.sh');

/** Git for Windows' bash (System32\bash.exe is WSL and must not be used); plain `bash` elsewhere. */
function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const candidate = join(dirname(dirname(dirname(exec))), 'bin', 'bash.exe');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const BASH = findBash();
let bin = '';

const FAKE_GH = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$FAKE_GH_MODE" in
  json) cat "$FAKE_GH_JSON" ;;
  notfound) echo "release not found" >&2; exit 1 ;;
  *) echo "HTTP 502: Bad Gateway" >&2; exit 1 ;;
esac
`;

function run(tag: string, mode: 'json' | 'notfound' | 'error', release?: unknown) {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
  const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH';
  env[pathKey] = bin + delimiter + (process.env[pathKey] ?? '');
  env.FAKE_GH_MODE = mode;
  env.FAKE_GH_LOG = join(bin, 'gh.log');
  env.FAKE_GH_JSON = join(bin, 'release.json');
  writeFileSync(env.FAKE_GH_LOG, '');
  writeFileSync(env.FAKE_GH_JSON, release === undefined ? '' : JSON.stringify(release));
  const r = spawnSync(BASH!, [SCRIPT, tag], { encoding: 'utf8', env });
  const out: Record<string, string> = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\w+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return { status: r.status, out, stderr: r.stderr, calls: readFileSync(env.FAKE_GH_LOG, 'utf8').trim() };
}

const asset = (name: string) => ({ name, size: 42, state: 'uploaded' });
const ALL = ['labnoteO_0.3.1_x64-setup.exe', 'labnoteO_0.3.1_x64-setup.exe.sig', 'latest.json'].map(asset);

describe.skipIf(!BASH)('release-state.sh', () => {
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'release-state-'));
    writeFileSync(join(bin, 'gh'), FAKE_GH.replace(/\r\n/g, '\n'), { mode: 0o755 });
  });
  afterAll(() => {
    if (bin) rmSync(bin, { recursive: true, force: true });
  });

  it('asks gh for the draft flag and the assets of exactly that tag', () => {
    const r = run('v0.3.1', 'json', { isDraft: false, assets: ALL });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toBe('release view v0.3.1 --json isDraft,assets');
  });

  it('complete only with latest.json, the installer and its signature, published', () => {
    expect(run('v0.3.1', 'json', { isDraft: false, assets: ALL }).out).toEqual({ state: 'complete', missing: '' });
    expect(run('v0.3.1', 'json', { isDraft: true, assets: ALL }).out.state).toBe('draft');
  });

  it('a half-uploaded release (no latest.json) is incomplete, not released', () => {
    const r = run('v0.3.1', 'json', { isDraft: false, assets: ALL.slice(0, 2) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ state: 'incomplete', missing: 'latest.json' });
  });

  it('"release not found" is state=none', () => {
    const r = run('v0.3.1', 'notfound');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ state: 'none' });
  });

  it('any other gh error fails closed with ::error:: and no state', () => {
    const r = run('v0.3.1', 'error');
    expect(r.status).not.toBe(0);
    expect(r.out.state).toBeUndefined();
    expect(r.stderr).toMatch(/::error::.*v0\.3\.1.*HTTP 502/);
  });

  it('refuses a tag that is not vX.Y.Z before calling gh', () => {
    for (const bad of ['0.3.1', 'v0.3', 'v0.3.1; echo state=complete', '']) {
      const r = run(bad, 'json', { isDraft: false, assets: ALL });
      expect(r.status, bad).not.toBe(0);
      expect(r.out.state, bad).toBeUndefined();
      expect(r.calls, bad).toBe('');
    }
  });
});
