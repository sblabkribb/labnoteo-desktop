/**
 * Static guards for .github/workflows/sync-core.yml (plan Task 10). The workflow runs only on GitHub, so these tests read it
 * as text and pin the release chain: a passing core update and the version bump go out in one atomic push together with the
 * new tag, the release is CALLED (a GITHUB_TOKEN tag push starts nothing), readiness is checked before any bump, the decision
 * comes from releaseChain.mjs, failures open deduplicated issues, and the token never reaches .git/config or upstream code.
 * Paths are relative to app/.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION_FILES } from '../../scripts/releaseChain.mjs';

const TEXT = readFileSync('../.github/workflows/sync-core.yml', 'utf8').replace(/\r\n/g, '\n');
const LINES = TEXT.split('\n');

/** The text of one job (from `  name:` to the next 2-space key). */
function job(name: string): string {
  const start = LINES.findIndex((l) => l === `  ${name}:`);
  expect(start, `jobs.${name}`).toBeGreaterThan(0);
  const out = [LINES[start]];
  for (const line of LINES.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

/** The steps of a job, in order (steps sit at 6 spaces under `steps:`). */
function steps(jobText: string): string[] {
  const lines = jobText.split('\n');
  const start = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  expect(start, 'steps').toBeGreaterThan(0);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,5}\S/.test(line)) break;
    if (/^ {6}- /.test(line)) out.push(line);
    else if (out.length) out[out.length - 1] += '\n' + line;
  }
  return out;
}

const SYNC = job('sync');
const STEPS = steps(SYNC);
const idx = (pattern: RegExp) => {
  const i = STEPS.findIndex((s) => pattern.test(s));
  expect(i, String(pattern)).toBeGreaterThanOrEqual(0);
  return i;
};
const step = (pattern: RegExp) => STEPS[idx(pattern)];

/** The `run:` bodies of every step of every job (block scalars included). */
function runBodies(): string[] {
  const all = TEXT.split(/\n(?= {6}- )/);
  return all.flatMap((s) => {
    const m = /\n {8}run: (\|\n((?: {10}.*\n?|\s*\n)*)|(.*))/.exec(s + '\n');
    return m ? [m[2] ?? m[3] ?? ''] : [];
  });
}

describe('sync-core.yml', () => {
  it('starts on an upstream release (repository_dispatch), by hand, and once a day as a fallback', () => {
    const on = /\non:\n((?: {2}.*\n|\s*\n)*)/.exec(TEXT);
    expect(on).not.toBeNull();
    const block = on![1];
    expect(block).toMatch(/^ {2}repository_dispatch:\n {4}types: \[labnoteo-release\]\n/m);
    expect(block).toMatch(/^ {2}workflow_dispatch:/m);
    const crons = [...block.matchAll(/cron: '([^']+)'/g)].map((m) => m[1]);
    expect(crons).toHaveLength(1);
    const [minute, hour, dom, month, dow] = crons[0].split(' ');
    // Once a day at a fixed time, not on the hour (GitHub's busiest minute).
    expect(minute).toMatch(/^\d+$/);
    expect(Number(minute)).toBeGreaterThan(0);
    expect(Number(minute)).toBeLessThan(60);
    expect(hour).toMatch(/^\d+$/);
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
    expect(TEXT).not.toMatch(/every 6 hours/i);
  });

  it('hands the dispatched release tag to the find script through env only, which still checks it is the newest', () => {
    const find = step(/id: find\b/);
    expect(find).toContain('REQUESTED_TAG: ${{ github.event.client_payload.tag || inputs.tag }}');
    expect(find).toMatch(/run: bash \.github\/scripts\/find-core-release\.sh \| tee -a "\$GITHUB_OUTPUT"/);
    expect(TEXT).toMatch(/\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}.*\n)*? {8}required: false\n/);
    // The payload is never interpolated anywhere else (and never into a run: body; see the token test).
    const uses = LINES.filter((l) => !l.trimStart().startsWith('#') && l.includes('client_payload'));
    expect(uses).toHaveLength(1);
  });

  it('exposes the tag and commit to release from the sync job', () => {
    expect(SYNC).toContain('      tag: ${{ steps.tagit.outputs.tag || steps.decide.outputs.tag }}');
    expect(SYNC).toContain('      sha: ${{ steps.tagit.outputs.sha || steps.decide.outputs.sha }}');
  });

  it('commits the core without pushing, and pushes main once, with the new tag in the same atomic push', () => {
    const commit = step(/name: Commit the update to main/);
    expect(commit).not.toMatch(/git push/);
    const pushers = STEPS.filter((s) => /git push/.test(s));
    expect(pushers).toHaveLength(1);
    const push = pushers[0];
    expect(push).toMatch(/id: tagit\b/);
    expect(push).toContain('git push --quiet --atomic "$remote" HEAD:main "refs/tags/$TAG"');
    expect(push).toMatch(/git push --quiet "\$remote" HEAD:main/);
    expect(push).toMatch(/echo "tag=\$TAG"/);
    expect(push).toMatch(/echo "sha=\$sha"/);
  });

  it('runs, in order: commit, readiness, decide, bump, push, then the issue steps', () => {
    const order = [
      idx(/name: Commit the update to main/),
      idx(/id: ready\b/),
      idx(/id: decide\b/),
      idx(/id: bump\b/),
      idx(/id: tagit\b/),
      idx(/name: Close core-sync issues/),
      idx(/name: Report a release that breaks the app/),
      idx(/name: Report that the sync itself could not run/),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[order.length - 1]).toBe(STEPS.length - 1);
  });

  it('checks readiness from the secret (as a boolean only) and the committed pubkey, and reports a blocked release', () => {
    const s = step(/id: ready\b/);
    expect(s).toContain("HAS_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY != '' }}");
    expect(s).toMatch(/releaseChain\.mjs pubkey-check/);
    expect(s).toMatch(/::warning::Automatic release skipped: /);
    expect(s).toMatch(/--label release-blocked/);
    expect(s).toContain('Automatic releases are waiting for the updater signing key');
    expect(s).toMatch(/gh issue close/);
    expect(s).toMatch(/echo "ready=\$ready" >> "\$GITHUB_OUTPUT"/);
    // The secret itself is never handed to this job; only its presence.
    for (const line of LINES) {
      if (line.includes('secrets.')) expect(line.trim()).toBe("HAS_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY != '' }}");
    }
  });

  it('decides from the newest vX.Y.Z tag, the core pointers and the release state', () => {
    const s = step(/id: decide\b/);
    expect(s).toMatch(/READY: \$\{\{ steps\.ready\.outputs\.ready \}\}/);
    expect(s).toMatch(/git fetch --quiet --force --tags "\$remote"/);
    expect(s).toMatch(/sort -V \| tail -n 1/);
    expect(s).toMatch(/git rev-parse HEAD:app\/vendor\/labnoteo/);
    expect(s).toContain('git rev-parse --verify --quiet "$NEWEST_TAG:app/vendor/labnoteo"');
    expect(s).toMatch(/gh release view "\$NEWEST_TAG"/);
    expect(s).toMatch(/release not found/);
    expect(s).toMatch(/node app\/scripts\/releaseChain\.mjs decide/);
    expect(s).toMatch(/git rev-list -n 1 "\$NEWEST_TAG"/);
    expect(s).toMatch(/no-first-release/);
  });

  it('bumps only on a bump decision, from the rebased main, touching exactly the version files', () => {
    const s = step(/id: bump\b/);
    expect(s).toContain("if: steps.decide.outputs.action == 'bump'");
    const pull = s.indexOf('git pull --rebase');
    const bump = s.indexOf('releaseChain.mjs bump');
    expect(pull).toBeGreaterThan(0);
    expect(bump).toBeGreaterThan(pull);
    const add = /git add ([^\n]+)/.exec(s);
    expect(add).not.toBeNull();
    expect(add![1].trim().split(/\s+/).sort()).toEqual([...VERSION_FILES].sort());
    expect(s).toMatch(/git commit -m "chore\(release\): v\$new for labnoteO /);
    expect(s).toMatch(/git tag "v\$new" HEAD/);
  });

  it('calls release.yml with the tag and commit from the sync job, inheriting the signing secrets', () => {
    const r = job('release');
    expect(r).toContain('    needs: sync');
    expect(r).toContain("    if: needs.sync.outputs.tag != ''");
    expect(r).toContain('    uses: ./.github/workflows/release.yml');
    expect(r).toContain('      tag: ${{ needs.sync.outputs.tag }}');
    expect(r).toContain('      sha: ${{ needs.sync.outputs.sha }}');
    expect(r).toContain('    secrets: inherit');
    expect(r).toMatch(/permissions:\n {6}contents: write/);
  });

  it('reports a failed release as a deduplicated issue and closes it once the tag is released', () => {
    const r = job('report-release');
    expect(r).toContain('    needs: [sync, release]');
    expect(r).toMatch(/if: always\(\) && needs\.sync\.outputs\.tag != \x27\x27/);
    expect(r).toMatch(/permissions:\n {6}issues: write/);
    expect(r).toMatch(/needs\.release\.result/);
    expect(r).toMatch(/Release \$TAG failed/);
    expect(r).toMatch(/gh issue create --label core-sync/);
    expect(r).toMatch(/gh issue close/);
    // The sync job also closes stale "Release vX failed" issues once that tag has a release (fixed by hand, say).
    expect(step(/name: Close release-failure issues/)).toMatch(/gh release view/);
    // ...and the generic close step leaves them alone.
    expect(step(/name: Close core-sync issues/)).toMatch(/startswith\("Release "\) \| not/);
  });

  it('reports a sync failure in any step except a red core, which has its own report', () => {
    expect(step(/name: Report that the sync itself could not run/)).toContain(
      "if: failure() && !(steps.find.outputs.behind == 'true' && steps.build.outcome != 'success')",
    );
  });

  it('keeps the token out of .git/config, out of upstream installs and out of run: interpolation', () => {
    expect(step(/uses: actions\/checkout@/)).toMatch(/persist-credentials: false/);
    // No job-wide token: npm install / test / build run upstream code.
    expect(SYNC.slice(0, SYNC.indexOf('    steps:'))).not.toMatch(/GH_TOKEN/);
    for (const name of ['Install', 'Test', 'Type-check and build']) {
      const s = STEPS.find((x) => x.includes(`name: ${name}`));
      expect(s, name).toBeDefined();
      expect(s).not.toMatch(/GH_TOKEN|github\.token/);
    }
    for (const line of LINES) {
      if (line.includes('x-access-token')) {
        expect(line.trim()).toBe('remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"');
      }
    }
    for (const body of runBodies()) expect(body).not.toMatch(/\$\{\{/);
  });

  it('keeps its own concurrency group, distinct from the called release', () => {
    expect(TEXT).toMatch(/\nconcurrency:\n {2}group: sync-core\n {2}cancel-in-progress: false/);
  });
});
