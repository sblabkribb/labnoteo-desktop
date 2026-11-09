/**
 * Static guards for .github/workflows/release.yml (plan Task 9). The workflow runs only on GitHub, so these tests read it as
 * text and pin what must never regress: the three triggers, refs taken from `inputs` before `github.*` (a called workflow sees
 * the caller's main), the signing secret only in `env:`, every guard before the build, the publish step last, and a skip when
 * the tag is already released. Paths are relative to app/.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TEXT = readFileSync('../.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');
const LINES = TEXT.split('\n');

/** The text of each step of jobs.windows, in order (steps sit at 6 spaces under `steps:`). */
function steps(): string[] {
  const start = LINES.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  expect(start, 'jobs.windows.steps').toBeGreaterThan(0);
  const out: string[] = [];
  for (const line of LINES.slice(start + 1)) {
    if (/^\S/.test(line) || /^ {1,3}\S/.test(line)) break; // left the steps list
    if (/^ {6}- /.test(line)) out.push(line);
    else if (out.length) out[out.length - 1] += '\n' + line;
  }
  return out;
}

const STEPS = steps();
const idx = (pattern: RegExp) => {
  const i = STEPS.findIndex((s) => pattern.test(s));
  expect(i, String(pattern)).toBeGreaterThanOrEqual(0);
  return i;
};

/** The `run:` bodies of every step (block scalars included). */
function runBodies(): string[] {
  return STEPS.flatMap((s) => {
    const m = /\n {8}run: (\|\n((?: {10}.*\n?|\s*\n)*)|(.*))/.exec(s + '\n');
    return m ? [m[2] ?? m[3] ?? ''] : [];
  });
}

describe('release.yml', () => {
  it('has the three triggers with the documented inputs', () => {
    const on = TEXT.slice(TEXT.indexOf('\non:'), TEXT.indexOf('\npermissions:'));
    expect(on).toMatch(/\n {2}push:\n {4}tags: \[\x27v\*\x27\]/); // \x27 = a quote (escapes.test reads quotes in a regex as a string)
    expect(on).toMatch(/\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:/);
    const call = on.slice(on.indexOf('workflow_call:'));
    expect(call).toMatch(/inputs:\n {6}tag:[\s\S]*?required: true[\s\S]*?\n {6}sha:[\s\S]*?required: true/);
    expect(call).toMatch(/secrets:\n {6}TAURI_SIGNING_PRIVATE_KEY:\n {8}required: false/);
    expect(call).toMatch(/\n {6}TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\n {8}required: false/);
  });

  it('never uses github.ref_name or github.sha without an inputs value first', () => {
    for (const line of LINES) {
      if (line.trimStart().startsWith('#')) continue;
      for (const m of line.matchAll(/github\.(ref_name|sha|ref)\b/g)) {
        const before = line.slice(0, m.index);
        expect(before, line).toMatch(/inputs\.(tag|sha)\b[^}]*\|\|[^}]*$/);
      }
    }
  });

  it('serializes runs per tag and runs bash on Windows', () => {
    expect(TEXT).toMatch(/concurrency:\n {6}group: release-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}\n {6}cancel-in-progress: false/);
    expect(TEXT).toMatch(/\n {6}TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
    expect(TEXT).toMatch(/defaults:\n {6}run:\n {8}shell: bash/);
  });

  it('keeps the signing secret out of every run: line', () => {
    for (const body of runBodies()) expect(body).not.toMatch(/secrets\.|\$\{\{/);
    for (const line of LINES) {
      if (!line.includes('secrets.')) continue;
      expect(line, 'secrets only as step env values').toMatch(/^ {10}[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
    }
  });

  it('checks, in order: already released, key set, checkout, tag commit, versions, pubkey, key id, tests, then publishes', () => {
    const pre = idx(/id: pre\b/);
    const keySet = idx(/-z "\$TAURI_SIGNING_PRIVATE_KEY"/);
    const checkout = idx(/uses: actions\/checkout@/);
    const tagCommit = idx(/git ls-remote/);
    const versions = idx(/releaseChain\.mjs versions/);
    const pubkey = idx(/releaseChain\.mjs pubkey-check/);
    const npmCi = idx(/run: npm ci/);
    const keyId = idx(/releaseChain\.mjs keyid-match/);
    const npmTest = idx(/run: npm test/);
    const cargo = idx(/cargo test/);
    const publish = idx(/uses: tauri-apps\/tauri-action@/);
    expect(pre).toBe(0);
    const order = [pre, keySet, checkout, tagCommit, versions, pubkey, npmCi, keyId, npmTest, cargo, publish];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(publish).toBe(STEPS.length - 1);
  });

  it('skips every step after the first when the release already exists, and fails closed on a lookup error', () => {
    const [first, ...rest] = STEPS;
    expect(first).toMatch(/gh release view "\$TAG"/);
    expect(first).toMatch(/release not found/);
    expect(first).toMatch(/skip=true/);
    expect(first).toMatch(/exit 1/);
    expect(first).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    for (const s of rest) expect(s).toMatch(/\n {8}if: steps\.pre\.outputs\.skip != 'true'/);
  });

  it('checks out the input commit (or the dispatched tag) without keeping credentials', () => {
    const s = STEPS[idx(/uses: actions\/checkout@/)];
    expect(s).toContain(
      "ref: ${{ inputs.sha || (inputs.tag && format('refs/tags/{0}', inputs.tag)) || github.sha }}",
    );
    expect(s).toMatch(/submodules: recursive/);
    expect(s).toMatch(/persist-credentials: false/);
  });

  it('publishes at the checked-out commit with the tag from inputs, signed, not a draft', () => {
    const s = STEPS[idx(/uses: tauri-apps\/tauri-action@/)];
    expect(s).toMatch(/tagName: \$\{\{ env\.TAG \}\}/);
    expect(s).toMatch(/releaseName: labnoteO \$\{\{ env\.TAG \}\}/);
    expect(s).toMatch(/commitish: \$\{\{ steps\.head\.outputs\.sha \}\}/);
    expect(STEPS[idx(/id: head\b/)]).toMatch(/git rev-parse HEAD/);
    expect(idx(/id: head\b/)).toBeLessThan(idx(/git ls-remote/) + 1);
    expect(s).toMatch(/releaseDraft: false/);
    expect(s).toMatch(/prerelease: false/);
    expect(s).toMatch(/includeUpdaterJson: true/);
    expect(s).toMatch(/--config src-tauri\/tauri\.release\.conf\.json/);
    expect(s).toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  });

  it('compares the version sites with the tag and deletes the key-id probe', () => {
    expect(STEPS[idx(/releaseChain\.mjs versions/)]).toMatch(/\$\{TAG#v\}/);
    const probe = STEPS[idx(/releaseChain\.mjs keyid-match/)];
    expect(probe).toMatch(/tauri signer sign/);
    expect(probe).toMatch(/trap 'rm -f [^']*probe[^']*' EXIT/);
  });
});
