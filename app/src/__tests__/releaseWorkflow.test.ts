/**
 * Static guards for .github/workflows/release.yml (plan Task 9). The workflow runs only on GitHub, so these tests read it as
 * text and pin what must never regress: the three triggers, refs taken from `inputs` before `github.*` (a called workflow sees
 * the caller's main), the signing secret only in `env:`, every guard before the build, a skip only when the tag's release is
 * complete (latest.json, installer and .sig: release-state.sh), and a draft that is published only after its assets are
 * checked, so releases/latest never points at a release without latest.json. Paths are relative to app/.
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
    // Optional sha on dispatch too, so `inputs.sha` is typed in every trigger (actionlint).
    const dispatch = on.slice(on.indexOf('workflow_dispatch:'), on.indexOf('workflow_call:'));
    expect(dispatch).toMatch(/\n {6}sha:\n(?: {8}.*\n)*? {8}required: false\n/);
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

  it('checks, in order: tag form, checkout, already released, key set, tag commit, versions, pubkey, key id, tests, then publishes', () => {
    const form = idx(/is not a release tag/);
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
    const remove = idx(/gh release delete/);
    const build = idx(/uses: tauri-apps\/tauri-action@/);
    const undraft = idx(/gh release edit/);
    expect(form).toBe(0);
    expect(checkout).toBe(1);
    expect(pre).toBe(2);
    const order = [form, checkout, pre, keySet, tagCommit, versions, pubkey, npmCi, keyId, npmTest, cargo, remove, build, undraft];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(remove).toBe(build - 1);
    expect(undraft).toBe(STEPS.length - 1);
  });

  it('refuses a tag that is not vX.Y.Z before checkout, without the token', () => {
    const s = STEPS[0];
    expect(s).toContain('^v[0-9]+');
    expect(s).toMatch(/exit 1/);
    expect(s).not.toMatch(/GH_TOKEN|github\.token/);
  });

  it('skips the build only when the release is complete, and fails closed on a lookup error', () => {
    const p = idx(/id: pre\b/);
    const pre = STEPS[p];
    expect(pre).toMatch(/bash \.github\/scripts\/release-state\.sh "\$TAG"/);
    expect(pre).not.toMatch(/gh release view/); // the asset rules live in release-state.sh / releaseChain.mjs
    // Each case arm, up to its `;;`.
    const arm = (label: string) => new RegExp(`\\n {12}${label}\\)\\n((?:(?! {12}\\S).*\\n)*?.*;;)`).exec(pre)?.[1] ?? '';
    expect(arm('complete')).toMatch(/skip=true/);
    expect(arm('none')).toMatch(/skip=false/);
    expect(arm('draft\\|incomplete')).toMatch(/skip=false/);
    expect(arm('\\*')).toMatch(/exit 1/);
    expect(pre.match(/skip=true/g)).toHaveLength(1);
    expect(pre).toMatch(/echo "state=\$state" >> "\$GITHUB_OUTPUT"/);
    expect(pre).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(pre).not.toMatch(/\n {8}if:/);
    for (const s of STEPS.slice(p + 1)) expect(s).toMatch(/\n {8}if: steps\.pre\.outputs\.skip != 'true'/);
  });

  it('removes a half-uploaded or unpublished release (keeping the tag) right before building it again', () => {
    const s = STEPS[idx(/gh release delete/)];
    expect(s).toContain("if: steps.pre.outputs.skip != 'true' && steps.pre.outputs.state != 'none'");
    expect(s).toMatch(/gh release delete "\$TAG" --yes/);
    expect(s).not.toMatch(/cleanup-tag/);
    expect(s).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  });

  it('publishes the draft only after release-state.sh sees every asset, and checks it once more after', () => {
    const s = STEPS[idx(/gh release edit/)];
    const first = s.indexOf('release-state.sh');
    const edit = s.indexOf('gh release edit "$TAG" --draft=false');
    const second = s.indexOf('release-state.sh', edit);
    expect(first).toBeGreaterThan(0);
    expect(edit).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(edit);
    expect(s).toMatch(/!= draft[\s\S]*?exit 1/);
    expect(s).toMatch(/!= complete[\s\S]*?exit 1/);
    expect(s).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  });

  it('never marks an older tag as the latest release when it publishes', () => {
    const s = STEPS[idx(/gh release edit/)];
    const fetch = s.indexOf('git fetch --force --tags origin');
    const newest = s.indexOf(
      String.raw`NEWEST=$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)`,
    );
    const edit = s.indexOf('gh release edit "$TAG" --draft=false');
    expect(fetch).toBeGreaterThan(0);
    expect(newest).toBeGreaterThan(fetch);
    expect(edit).toBeGreaterThan(newest);
    expect(s).toMatch(/if \[ "\$TAG" != "\$NEWEST" \]; then\n\s*latest=--latest=false/);
    expect(s).toMatch(/gh release edit "\$TAG" --draft=false \$latest/);
  });

  it('checks out the input commit (or the dispatched tag) without keeping credentials', () => {
    const s = STEPS[idx(/uses: actions\/checkout@/)];
    expect(s).toContain(
      "ref: ${{ inputs.sha || (inputs.tag && format('refs/tags/{0}', inputs.tag)) || github.sha }}",
    );
    expect(s).toMatch(/submodules: recursive/);
    expect(s).toMatch(/persist-credentials: false/);
  });

  it('uploads to a draft at the checked-out commit with the tag from inputs, signed', () => {
    const s = STEPS[idx(/uses: tauri-apps\/tauri-action@/)];
    expect(s).toMatch(/tagName: \$\{\{ env\.TAG \}\}/);
    expect(s).toMatch(/releaseName: labnoteO \$\{\{ env\.TAG \}\}/);
    expect(s).toMatch(/commitish: \$\{\{ steps\.head\.outputs\.sha \}\}/);
    expect(STEPS[idx(/id: head\b/)]).toMatch(/git rev-parse HEAD/);
    expect(idx(/id: head\b/)).toBeLessThan(idx(/git ls-remote/) + 1);
    expect(s).toMatch(/releaseDraft: true/);
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
