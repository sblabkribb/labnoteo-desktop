// @vitest-environment jsdom
/**
 * SP7 regression sweep (Task 38): the CSP and the window capabilities did not move, SP7 sources set no inline style, assign no
 * HTML and do no network of their own, every SP7 command left the inventory's DEFERRED list, no token reaches settings or
 * integration state, and the four new npm packages carry a permissive licence. Paths are relative to app/.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../i18n/lang';
import { fakeInvoke, secretStatusOf } from '../integrations/__tests__/fakeNet';
import type { IntegrationDeps, IntegrationSettingsValue } from '../integrations/IntegrationSettingsDialog';
import { clearSecret, secretStatus, setSecret, type Slot } from '../integrations/netIpc';
import { clearCommandsForTest, commands } from '../labnote/commands/registry';
import { registerAllCommands } from '../labnote/commands/registerAll';
import { coreT } from '../labnote/i18n';
import { McpSection } from '../labnote/mcp/McpSection';
import { SlackInbox } from '../labnote/port/slackInbox';
import { ScanSettingsSection, type ScanSettingsFeature } from '../labnote/scan/ScanSettingsSection';
import type { ScanFolderStatus } from '../labnote/scan/scanIpc';
import { fromStored, saveVaultSettings, type AppSettings } from '../labnote/settings';

beforeEach(() => setLang('en'));
afterEach(() => {
  cleanup();
  clearCommandsForTest();
  setLang('ko');
});

// ── CSP and capabilities ─────────────────────────────────────────

/** sha256 (hex) of `app.security.csp` as SP6 left it (unchanged since `147eeba`; SP6 Task 42 kept it). */
const PINNED_CSP_SHA256 = '1f98f75cbb06294027e5139aee487f2306fd1b523fe9c2c1ce88b152a2a378cc';

/** `capabilities/default.json` permissions as SP6 left them (the list `csp.test.ts` also pins). */
const SP6_PERMISSIONS = [
  'core:default',
  'core:window:allow-destroy',
  'core:window:allow-set-theme',
  'core:window:allow-show',
  'dialog:allow-open',
  'dialog:allow-save',
  'updater:default',
  'process:allow-restart',
  { identifier: 'opener:allow-open-url', allow: [{ url: 'http://*' }, { url: 'https://*' }, { url: 'mailto:*' }, { url: 'partbank:*' }] },
];

// ── SP7 sources ──────────────────────────────────────────────────

const SP7_PORTS = [
  // Part A
  'qr',
  'texHtml',
  'scanNames',
  'noteIdService',
  'printPages',
  'worksheetPrint',
  'fullNotePrint',
  'barcodeDialog',
  'barcodeActions',
  // Part B
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
  // Part C
  'mcpApproval',
  'mcpCall',
];

const SP7_PATHS = [
  'src/labnote/barcode',
  'src/labnote/print',
  'src/labnote/scan',
  'src/labnote/mcp',
  'src/labnote/host/whenNotComposing.ts',
  ...SP7_PORTS.map((n) => `src/labnote/port/${n}`),
];

const SOURCE = /\.tsx?$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
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
    if (!file) throw new Error(`SP7 source not found: ${p}`);
    out.push(file);
  }
  return out;
}

const FORBIDDEN = /style=\{|\.style\.|innerHTML\s*=(?!=)|outerHTML\s*=(?!=)|insertAdjacentHTML|\bfetch\(|XMLHttpRequest/;

// ── Command inventory ────────────────────────────────────────────

const SP7_COMMANDS = [
  'show-note-barcode',
  'assign-note-id',
  'print-experiment-worksheet',
  'print-whole-note',
  'import-scanned-pages',
  'process-scan-folder',
  'assign-unmatched-scans',
  'toggle-mcp-server',
];

/** The `DEFERRED` map's body in the inventory test (not exported, so it is read as text). */
function deferredBlock(): string {
  const text = readFileSync('src/labnote/__tests__/commandInventory.test.ts', 'utf-8');
  const m = /const DEFERRED: Record<string, string> = \{([\s\S]*?)\n\};/.exec(text);
  if (!m) throw new Error('DEFERRED not found in commandInventory.test.ts');
  return m[1];
}

// ── Token leaks ──────────────────────────────────────────────────

const TOKEN_LIKE = /xox[abpr]-|[0-9a-f]{48}/;
/** What Rust holds as the MCP token in this test; it never crosses the fake IPC. */
const RUST_MCP_TOKEN = 'ab'.repeat(24);
const SLACK_TOKEN = 'xoxb-1234-5678-leakysecret';
const ALL_SCOPES = 'im:history,im:read,files:read,chat:write,reactions:write';
const NO_FOLDER: ScanFolderStatus = { path: null, mode: 'dedicated', exists: false, insideVault: false, since: null, baseline: null };

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => undefined);
}

describe('SP7 guards', () => {
  it('the CSP is byte-identical and capabilities gained no permission', () => {
    const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf-8'));
    expect(createHash('sha256').update(conf.app.security.csp, 'utf8').digest('hex')).toBe(PINNED_CSP_SHA256);
    const cap = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf-8'));
    expect(cap.windows).toEqual(['main']);
    expect(cap.permissions).toEqual(SP6_PERMISSIONS);
  });

  it('SP7 sources set no inline style, assign no innerHTML, and call no fetch or XMLHttpRequest', () => {
    const files = sourcesUnder(SP7_PATHS).map((f) => f.replace(/\\/g, '/'));
    // not vacuous: every part's folders and ports resolved to files
    expect(files.length).toBeGreaterThanOrEqual(SP7_PATHS.length);
    for (const dir of ['barcode', 'print', 'scan', 'mcp']) expect(files.some((f) => f.startsWith(`src/labnote/${dir}/`)), dir).toBe(true);
    for (const f of files) expect(readFileSync(f, 'utf-8'), f).not.toMatch(FORBIDDEN);
    // the pattern catches what it should, and lets comparisons and reads through
    for (const bad of ['<p style={{}} />', 'el.style.top = "1px"', 'el.innerHTML = s', 'el.outerHTML= s', 'el.insertAdjacentHTML("x", s)', 'await fetch(u)', 'new XMLHttpRequest()']) {
      expect(bad).toMatch(FORBIDDEN);
    }
    for (const ok of ['if (el.innerHTML === s) {}', 'const html = root.outerHTML;', 'client.prefetch(u)']) expect(ok).not.toMatch(FORBIDDEN);
  });

  it('no command inventory entry is left as barcode or SP7', () => {
    const deferred = deferredBlock();
    expect(deferred).toContain("'renumber-workflows'"); // read the real map
    for (const id of SP7_COMMANDS) expect(deferred, id).not.toContain(`'${id}'`);
    expect(deferred).not.toMatch(/SP7|barcode/i);
    registerAllCommands();
    const registered = new Set(commands().map((c) => c.id));
    expect(SP7_COMMANDS.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('no token-like value is ever written to settings or integration state', async () => {
    const state = new Map<string, string>();
    const keys: Partial<Record<Slot, boolean>> = { slackBot: false };
    let running = false;
    let clipboard = '';
    const rust = fakeInvoke({
      settings_vault_write: () => null,
      scan_folder_status: () => NO_FOLDER,
      secret_status: () => secretStatusOf(keys),
      secret_set: (a) => {
        if (!String(a.value).startsWith('xoxb-')) throw { kind: 'badInput', message: 'bad token' };
        keys[a.slot as Slot] = true;
        return null;
      },
      secret_clear: (a) => {
        keys[a.slot as Slot] = false;
        return null;
      },
      integration_state_read: (a) => state.get(String(a.name)) ?? null,
      integration_state_write: (a) => {
        state.set(String(a.name), String(a.content));
        return null;
      },
      slack_call: (a) =>
        a.method === 'authTest' ? { status: 200, json: { ok: true, user: 'labbot' }, scopes: ALL_SCOPES } : { status: 200, json: { ok: true } },
      mcp_status: () => ({ running, port: running ? 3987 : null, tokenSet: true, tokenEpoch: 1 }),
      mcp_start: () => {
        running = true;
        return { running, port: 3987, tokenSet: true, tokenEpoch: 1 };
      },
      mcp_stop: () => {
        running = false;
        return null;
      },
      mcp_drain: () => 0,
      mcp_token_status: () => ({ set: true, epoch: 1 }),
      // Rust writes the clipboard itself; the token never comes back over IPC
      mcp_token_copy: (a) => {
        clipboard = a.snippet == null ? RUST_MCP_TOKEN : String(a.snippet).replace('<token>', RUST_MCP_TOKEN);
        return null;
      },
    });

    // the app's settings path: every change is saved with settings_vault_write
    let settings: AppSettings = fromStored({});
    const save = async (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch };
      await saveVaultSettings(settings, rust.invoke);
    };
    let current: IntegrationSettingsValue = {
      partbankDesktopUrl: settings.partbankDesktopUrl,
      partbankWebUrl: settings.partbankWebUrl,
      partbankDefaultConnection: settings.partbankDefaultConnection,
      partbankSendUsages: settings.partbankSendUsages,
      llmProvider: settings.llmProvider,
      llmEndpointOllama: settings.llmEndpointOllama,
      llmEndpointOpenai: settings.llmEndpointOpenai,
      llmModel: settings.llmModel,
      bfwUrl: settings.bfwUrl,
      bfwConnection: settings.bfwConnection,
      allowHttpOrigins: [...settings.allowHttpOrigins],
      worksheetPaperSize: settings.worksheetPaperSize,
      scanMaxImageEdge: settings.scanMaxImageEdge,
      scanJpegQuality: settings.scanJpegQuality,
      scanEmbedWidth: settings.scanEmbedWidth,
      mcpEnabled: settings.mcpEnabled,
      mcpPort: settings.mcpPort,
    };
    const deps: IntegrationDeps = {
      value: () => current,
      commit: async (patch) => {
        current = { ...current, ...patch };
        await save(patch);
      },
      status: () => secretStatus(rust.invoke),
      setSecret: (slot, v) => setSecret(slot, v, rust.invoke),
      clearSecret: (slot) => clearSecret(slot, rust.invoke),
    };
    const slack = new SlackInbox({ run: async () => [], summarize: () => '', notify: () => undefined, report: () => undefined, invoke: rust.invoke });
    const start = vi.spyOn(slack, 'start').mockImplementation(() => undefined);
    const feature: ScanSettingsFeature = {
      watcher: { restart: vi.fn() },
      slack,
      processFolderNow: vi.fn(async () => undefined),
      openUnmatched: vi.fn(async () => undefined),
      unmatchedCount: vi.fn(async () => 0),
    };
    const notes: string[] = [];
    render(
      createElement(
        'div',
        null,
        createElement(ScanSettingsSection, { deps, invoke: rust.invoke, feature }),
        createElement(McpSection, {
          enabled: false,
          port: 3987,
          commit: (patch: Partial<Pick<AppSettings, 'mcpEnabled' | 'mcpPort'>>) => deps.commit(patch),
          notify: (_kind: unknown, message: string) => void notes.push(message),
          invoke: rust.invoke,
        }),
      ),
    );

    // Slack Connect with a typed bot token
    const key = (await screen.findByLabelText(coreT('Slack bot token'))) as HTMLInputElement;
    fireEvent.change(key, { target: { value: SLACK_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: coreT('Connect') }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // a paper-size change goes through the same settings write
    await deps.commit({ worksheetPaperSize: 'letter' });

    // MCP: enable the server (saved), then Copy token
    fireEvent.click(await screen.findByRole('checkbox', { name: coreT('Enable MCP server') }));
    await flush();
    fireEvent.click(await screen.findByRole('button', { name: coreT('Copy token') }));
    await flush();

    // the flows really ran: the key went to the keychain slot, Rust copied the token, and both stores were written
    expect(rust.calls).toContainEqual(['secret_set', { slot: 'slackBot', value: SLACK_TOKEN }]);
    expect(clipboard).toBe(RUST_MCP_TOKEN);
    const settingsWrites = rust.calls.filter(([c]) => c === 'settings_vault_write');
    const stateWrites = rust.calls.filter(([c]) => c === 'integration_state_write');
    expect(settingsWrites.length).toBeGreaterThan(0);
    expect(stateWrites.length).toBeGreaterThan(0);
    expect(settingsWrites.some(([, a]) => String(a.content).includes('"mcpEnabled":true'))).toBe(true);
    expect(stateWrites.some(([c, a]) => c === 'integration_state_write' && a.name === 'slackLink')).toBe(true);

    for (const [cmd, args] of [...settingsWrites, ...stateWrites]) expect(JSON.stringify(args), cmd).not.toMatch(TOKEN_LIKE);
    // nothing Rust answered carried the MCP token, and neither token is on the page (its help text names the xoxb- prefix)
    expect(JSON.stringify(rust.calls)).not.toContain(RUST_MCP_TOKEN);
    for (const secret of [SLACK_TOKEN, RUST_MCP_TOKEN]) {
      expect(document.body.textContent).not.toContain(secret);
      expect(notes.join('\n')).not.toContain(secret);
    }
    // the detector itself sees both token shapes
    expect(SLACK_TOKEN).toMatch(TOKEN_LIKE);
    expect(RUST_MCP_TOKEN).toMatch(TOKEN_LIKE);
  });

  it('every SP7 npm dependency has a permissive licence', () => {
    for (const p of ['qrcode-generator', 'jsqr', 'fflate', 'pdfjs-dist']) {
      expect(['MIT', 'Apache-2.0'], p).toContain(JSON.parse(readFileSync(`node_modules/${p}/package.json`, 'utf-8')).license);
    }
  });
});
