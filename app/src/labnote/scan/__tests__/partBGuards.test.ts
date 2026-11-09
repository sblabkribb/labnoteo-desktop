import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setLang } from '../../../i18n/lang';
import { fakeInvoke } from '../../../integrations/__tests__/fakeNet';
import { coreT } from '../../i18n';
import { ScanFolderWatcher } from '../../port/scanFolderWatcher';
import type { ScanResult, UnmatchedReason, UnsupportedReason } from '../../port/scanPipeline';
import { describeResult, summarizeResults, unmatchedReasonText } from '../../port/scanResults';
import { folderStateLine, slackStatusLine } from '../../port/scanSettings';
import { describeSlackError } from '../../port/slackInbox';
import type { ScanFolderStatus, SlackLink } from '../scanIpc';

// SP7 Part B guards. Paths are relative to app/ (vitest's working directory).
const PART_B = [
  'src/labnote/scan',
  ...[
    'imageStore',
    'pageDecoder',
    'pdfPages',
    'scanDecode',
    'scanFeatureRuns',
    'scanFolderWatcher',
    'scanMoves',
    'scanPipeline',
    'scanResults',
    'scanSettings',
    'slackInbox',
    'unmatchedScans',
  ].map((n) => `src/labnote/port/${n}`),
];

const SOURCE = /\.tsx?$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(name)) out.push(p);
  }
}

/** The `.ts`/`.tsx` files (no `__tests__`) under each path; a bare port name gets its extension. */
function sourcesUnder(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (existsSync(p) && statSync(p).isDirectory()) {
      walk(p, out);
      continue;
    }
    const file = [p, `${p}.ts`, `${p}.tsx`].find((c) => SOURCE.test(c) && existsSync(c));
    if (!file) throw new Error(`Part B source not found: ${p}`);
    out.push(file);
  }
  return out;
}

const FORBIDDEN_NAMES = /Obsidian|Labnote Assistant|docs\/SCAN\.md/;

/** Every Slack error code the app knows how to explain, and the ones the Slack tests use. */
const SLACK_CODES = [
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'app_uninstalled',
  'missing_scope',
  'channel_not_found',
  'not_in_channel',
  'already_reacted',
  'ratelimited',
  'HTTP error',
  'net::ERR_INTERNET_DISCONNECTED',
];
const UNMATCHED: UnmatchedReason[] = ['no-qr', 'note-not-found', 'duplicate-id', 'note-only', 'no-unit-op', 'ambiguous', 'renamed', 'note-busy'];
const UNSUPPORTED: UnsupportedReason[] = ['heic', 'tiff', 'unknown', 'zip-limit', 'pdf-limit'];

afterEach(() => setLang('ko'));

describe('SP7 Part B guards', () => {
  it('every guarded path resolves to sources, so the guards are not vacuous', () => {
    const files = sourcesUnder(PART_B).map((f) => f.replace(/\\/g, '/'));
    expect(files.length).toBeGreaterThanOrEqual(PART_B.length);
    expect(files).toContain('src/labnote/scan/commands.ts');
    expect(files).toContain('src/labnote/scan/ScanSettingsSection.tsx');
  });

  it('Part B sources set no inline style and assign no innerHTML', () => {
    for (const f of sourcesUnder(PART_B)) {
      expect(readFileSync(f, 'utf-8'), f).not.toMatch(/style=\{|\.style\.|innerHTML\s*=(?!=)|outerHTML\s*=(?!=)|insertAdjacentHTML/);
    }
  });

  it('no Part B notice or label names Obsidian, Labnote Assistant or docs/SCAN.md', async () => {
    const noFolder: ScanFolderStatus = { path: null, mode: 'dedicated', exists: false, insideVault: false, since: null, baseline: null };
    const inside: ScanFolderStatus = { path: 'C:/vault/scans', mode: 'shared', exists: true, insideVault: true, since: 1, baseline: [] };
    const link: SlackLink = { enabled: true, mode: 'dm', channelId: '', linkCode: 'ABC123', userId: 'U1', lastTs: '', claimedTs: [] };
    for (const lang of ['ko', 'en'] as const) {
      setLang(lang);
      const texts: string[] = [];

      // The folder watcher asked to process with no folder set.
      const f = fakeInvoke({ scan_folder_status: () => noFolder });
      const watcher = new ScanFolderWatcher({
        run: async () => [],
        report: () => undefined,
        notify: (m) => texts.push(m),
        invoke: f.invoke,
        listen: async () => () => undefined,
      });
      await watcher.tick({ manual: true });
      expect(texts.length).toBeGreaterThan(0);

      for (const code of SLACK_CODES) texts.push(describeSlackError(coreT, code));

      const results: ScanResult[] = [
        ...UNMATCHED.map((reason): ScanResult => ({ status: 'unmatched', source: 'a.jpg', reason, payload: { noteId: 'LN-AAAAAAAA' } } as ScanResult)),
        ...UNSUPPORTED.map((reason): ScanResult => ({ status: 'unsupported', source: 'a.heic', reason } as ScanResult)),
      ];
      for (const r of results) texts.push(describeResult(coreT, r));
      for (const reason of UNMATCHED) texts.push(unmatchedReasonText(coreT, reason, 'LN-AAAAAAAA'));
      texts.push(summarizeResults(coreT, results));

      // The settings section's lines: a folder inside the vault, and a Slack check that failed.
      texts.push(folderStateLine(coreT, inside)!.text);
      for (const code of SLACK_CODES) {
        texts.push(slackStatusLine(coreT, link, code));
        texts.push(slackStatusLine(coreT, { ...link, userId: '' }, code));
      }

      for (const text of texts) expect(text, `${lang}: ${text}`).not.toMatch(FORBIDDEN_NAMES);
    }
  });
});
