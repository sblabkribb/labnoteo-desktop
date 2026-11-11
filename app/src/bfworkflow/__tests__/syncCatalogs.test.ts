// @vitest-environment jsdom
import { catalogs, t } from '../../i18n/t';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../../editor/commands/appCommands';
import { clearCommandsForTest } from '../../labnote/commands/registry';
import { probeFor } from '../../integrations/probes';
import { notifySecretsChange } from '../../integrations/secretsEvents';
import type { NetError } from '../../integrations/netIpc';
import { fakeInvoke, netError, secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { runBfwSyncCatalogs } from '../syncCatalogs';
import { bfwReady, startBfworkflow } from '../bfwApp';

const DIR = 'resources/workflows';
const WF = `${DIR}/workflows_en.json`;
const HW = `${DIR}/unitoperations_hw_en.json`;
const SW = `${DIR}/unitoperations_sw_en.json`;

const json = (v: unknown) => JSON.stringify(v, null, 2);

function vaultFiles(): Record<string, string> {
  return {
    [WF]: json({
      version: '0.4.1',
      language: 'English',
      lastUpdated: '2025-08-15',
      workflows: [
        { id: 'WB030', name: 'PCR (lab)', description: 'Amplify', category: 'Build' },
        { id: 'WX999', name: 'Lab only', description: '', category: 'Build' },
      ],
    }),
    [HW]: json({
      version: '0.4',
      language: 'English',
      lastUpdated: '2025-08-15',
      unitOperations: [{ id: 'UHW010', name: 'Liquid Handling', description: '', equipment: 'Dispenser' }],
    }),
    [SW]: json({ version: '0.4', language: 'English', lastUpdated: '2025-08-15', unitOperations: [] }),
  };
}

const SERVER_WF = [
  { workflow_id: 'WB030', name: 'PCR', domain: 'build', description: 'Amplify', paper_count: 3 },
  { workflow_id: 'WT010', name: 'Assay', domain: '', description: '' },
];
const SERVER_UO = {
  unit_operations: {
    UHW010: { id: 'UHW010', name: 'Liquid Handling', type: 'hardware', description: '', equipment: 'Dispenser' },
    USW005: { id: 'USW005', name: 'Primer design', type: 'software', description: 'd', software: ['Benchling', 'Primer3'] },
  },
};

/** The workflow rows and UO json that equal vaultFiles() exactly. */
const SAME_WF = [
  { workflow_id: 'WB030', name: 'PCR (lab)', domain: 'build', description: 'Amplify' },
  { workflow_id: 'WX999', name: 'ignored', domain: 'build' }, // unsafe-looking id: skipped, vault copy kept
];
const SAME_UO = {
  unit_operations: { UHW010: { id: 'UHW010', name: 'Liquid Handling', type: 'hardware', description: '', equipment: 'Dispenser' } },
};

interface Setup {
  th: TestHost;
  net: ReturnType<typeof fakeInvoke>;
  root: { value: string };
}

function setup(opts: { wf?: unknown; uo?: unknown; fail?: NetError; files?: Record<string, string> } = {}): Setup {
  const th = createTestHost(opts.files ?? vaultFiles());
  const root = { value: 'C:/fake-vault' };
  const net = fakeInvoke({
    bfw_request: (a) => {
      if (opts.fail) throw opts.fail;
      return a.path === '/api/workflow-catalog' ? (opts.wf ?? SERVER_WF) : (opts.uo ?? SERVER_UO);
    },
    bfw_base: () => 'https://workflow.kbiofoundry.kr/',
    integration_state_write: () => null,
    vault_current: () => ({ root: root.value }),
    net_cancel: () => true,
  });
  return { th, net, root };
}

const readJson = (th: TestHost, path: string) => JSON.parse(th.vault.files()[path]) as Record<string, unknown>;
const ids = (th: TestHost, path: string, key: string) =>
  (readJson(th, path)[key] as Array<{ id: string }>).map((x) => x.id);
const cmdNames = (s: Setup) => s.net.calls.map(([c]) => c);

afterEach(() => {
  clearAppCommandsForTest();
  clearCommandsForTest();
});

describe('bfworkflow: Sync catalogs', () => {
  it('server wins for the same id and vault-only entries are kept', async () => {
    const s = setup();
    s.th.answer.confirm(true);
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    const wf = readJson(s.th, WF);
    const rows = wf.workflows as Array<{ id: string; name: string; category: string }>;
    expect(rows.map((r) => r.id)).toEqual(['WB030', 'WT010', 'WX999']);
    expect(rows.find((r) => r.id === 'WB030')!.name).toBe('PCR');
    expect(rows.find((r) => r.id === 'WX999')!.name).toBe('Lab only');
    expect(rows.find((r) => r.id === 'WT010')!.category).toBe('Test');
    expect(wf.version).toMatch(/^bfworkflow-[0-9a-f]{12}$/);
    expect(wf.language).toBe('en');
    expect(wf.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.th.vault.files()[WF].endsWith('}\n')).toBe(true);
    expect(s.th.vault.files()[WF]).toContain('\n  "workflows": [');
    expect(ids(s.th, SW, 'unitOperations')).toEqual(['USW005']);
    expect((readJson(s.th, SW).unitOperations as Array<{ software: string }>)[0].software).toBe('Benchling, Primer3');
    expect(s.th.asked.confirm).toHaveLength(1);
    // 1 added workflow (WT010) + 1 added sw (USW005); 1 changed (WB030); 1 kept (WX999); 0 skipped
    expect(s.th.asked.confirm[0].message).toBe(t('bfw.catalogsConfirm', 2, 1, 1, 0));
    expect(s.th.asked.confirm[0].opts?.confirmLabel).toBe(t('bfw.apply'));
    // real-server check: the confirm has a title, and the end says what changed
    expect(s.th.asked.confirm[0].opts?.title).toBe(t('bfw.catalogsConfirmTitle'));
    expect(s.th.notes).toEqual([{ kind: 'info', message: t('bfw.catalogsUpdated', 2, 1) }]);
    expect(s.th.refreshes()).toBe(1);
  });

  it('writes the cache through integration_state_write, never into the vault root', async () => {
    const s = setup();
    const before = Object.keys(s.th.vault.files()).sort();
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke); // confirm declined
    const writes = s.net.calls.filter(([c]) => c === 'integration_state_write');
    expect(writes).toHaveLength(1);
    expect(writes[0][1].name).toBe('bfwCatalogCache');
    expect(Object.keys(s.th.vault.files()).sort()).toEqual(before);
  });

  it('unchanged catalogs give the up-to-date notice and write nothing', async () => {
    const s = setup({ wf: SAME_WF.slice(0, 1), uo: SAME_UO });
    const before = s.th.vault.files();
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.asked.confirm).toHaveLength(0);
    expect(s.th.notes).toEqual([{ kind: 'info', message: t('bfw.catalogsCurrent') }]);
    expect(s.th.vault.files()).toEqual(before);
    expect(s.th.refreshes()).toBe(0);
  });

  it('declining the confirm writes nothing', async () => {
    const s = setup();
    const before = s.th.vault.files();
    s.th.answer.confirm(false);
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.asked.confirm).toHaveLength(1);
    expect(s.th.vault.files()).toEqual(before);
    expect(s.th.refreshes()).toBe(0);
    expect(s.th.notes).toEqual([]);
  });

  it('offline keeps the vault catalogs and warns', async () => {
    const s = setup({ fail: netError('offline') });
    const before = s.th.vault.files();
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.vault.files()).toEqual(before);
    expect(s.th.asked.confirm).toHaveLength(0);
    expect(cmdNames(s)).not.toContain('integration_state_write');
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.offline', 'https://workflow.kbiofoundry.kr') }]);
    expect(s.th.notes[0].message).not.toContain('raw-rust-text');
  });

  it('a 403 names the read scope', async () => {
    const s = setup({ fail: netError('status', { status: 403, body: 'scope' }) });
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.noScope', 'read') }]);
    expect(catalogs.en['bfw.noScope']).toBe('The API key lacks the {0} scope.');
    expect(catalogs.ko['bfw.noScope']).toBe('API 키에 {0} 스코프가 없습니다.');
  });

  it('other failures name their reason and never the raw Rust text', async () => {
    const cases: Array<[NetError, string]> = [
      [netError('status', { status: 401 }), t('bfw.keyRefused')],
      [netError('status', { status: 429 }), t('bfw.rateLimited')],
      [netError('status', { status: 500 }), t('bfw.failed', 'HTTP 500')],
      [netError('notConfigured'), t('bfw.notConfigured')],
      [netError('redirect', { location: 'https://other.example' }), t('integrations.redirected', 'https://other.example')],
      [netError('insecure'), t('integrations.insecure')],
      [netError('keychain'), t('integrations.keychain')],
      [netError('tooLarge'), t('integrations.tooLarge')],
    ];
    for (const [err, text] of cases) {
      const s = setup({ fail: err });
      await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
      expect(s.th.notes).toEqual([{ kind: 'warn', message: text }]);
    }
  });

  it('notConfigured on the desktop connection says the desktop app is not running', async () => {
    const s = setup({ fail: netError('notConfigured') });
    await s.th.ctx.updateSettings({ bfwConnection: 'desktop' });
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.desktopNotRunning') }]);
  });

  it('the cache is written as a JSON string with the server origin', async () => {
    const s = setup();
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    const write = s.net.calls.find(([c]) => c === 'integration_state_write')!;
    expect(Object.keys(write[1]).sort()).toEqual(['content', 'name']);
    expect(write[1].name).toBe('bfwCatalogCache');
    expect(typeof write[1].content).toBe('string');
    const cache = JSON.parse(write[1].content as string) as Record<string, unknown>;
    expect(cache.origin).toBe('https://workflow.kbiofoundry.kr');
    expect(typeof cache.fetchedAt).toBe('string');
    expect(typeof cache.hash).toBe('string');
    expect((cache.workflows as Array<{ id: string }>).map((w) => w.id)).toEqual(['WB030', 'WT010']);
    expect((cache.hw as Array<{ id: string }>).map((w) => w.id)).toEqual(['UHW010']);
    expect((cache.sw as Array<{ id: string }>).map((w) => w.id)).toEqual(['USW005']);
  });

  it('rows with unsafe ids are skipped and counted, never written', async () => {
    const s = setup({
      wf: [...SERVER_WF, { workflow_id: '../x', name: 'Evil', domain: 'build' }],
      uo: { unit_operations: { ...SERVER_UO.unit_operations, 'a/b': { id: 'a/b', name: 'Bad' } } },
    });
    s.th.answer.confirm(true);
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.asked.confirm[0].message).toBe(t('bfw.catalogsConfirm', 2, 1, 1, 2));
    expect(ids(s.th, WF, 'workflows')).not.toContain('../x');
    expect(s.th.vault.files()[WF]).not.toContain('Evil');
    expect(Object.keys(s.th.vault.files()).some((p) => p.includes('..') || p.includes('a/b'))).toBe(false);
  });

  it('a vault switch before the confirm answer writes nothing', async () => {
    const s = setup();
    const before = s.th.vault.files();
    s.th.answer.confirm(() => {
      s.root.value = 'C:/other-vault';
      return true;
    });
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.asked.confirm).toHaveLength(1);
    expect(s.th.vault.files()).toEqual(before);
    expect(s.th.refreshes()).toBe(0);
    expect(s.th.notes.filter((n) => n.kind === 'warn')).toEqual([]);
  });

  it('an unreadable vault catalog is left as it is', async () => {
    const files = { ...vaultFiles(), [WF]: '{ not json' };
    const s = setup({ files });
    s.th.answer.confirm(true);
    await runBfwSyncCatalogs(s.th.ctx, s.net.invoke);
    expect(s.th.vault.files()[WF]).toBe('{ not json');
    expect(s.th.notes).toContainEqual({ kind: 'warn', message: t('bfw.catalogBroken', WF) });
    expect(ids(s.th, SW, 'unitOperations')).toEqual(['USW005']);
  });
});

describe('bfworkflow readiness and probe', () => {
  it('the command is hidden until a bfworkflow key is set, and shows once a key is saved', async () => {
    const th = createTestHost(vaultFiles());
    const net = fakeInvoke({ secret_status: () => secretStatusOf({}) });
    registerAllAppCommands();
    const cmd = appCommands().find((c) => c.id === 'app.bfw-sync-catalogs')!;
    expect(cmd.nameKey).toBe('cmd.bfwSyncCatalogs');
    expect(catalogs.ko['cmd.bfwSyncCatalogs']).toBe('bfworkflow: 카탈로그 동기화');
    expect(catalogs.en['cmd.bfwSyncCatalogs']).toBe('bfworkflow: Sync catalogs');
    const stop = startBfworkflow(th.ctx, net.invoke);
    try {
      await vi.waitFor(() => expect(net.calls.map(([c]) => c)).toContain('secret_status'));
      await Promise.resolve();
      expect(bfwReady(th.ctx)).toBe(false);
      expect(cmd.available!(th.ctx)).toBe(false);
      notifySecretsChange(secretStatusOf({ bfwServer: true }));
      expect(bfwReady(th.ctx)).toBe(true);
      expect(cmd.available!(th.ctx)).toBe(true);
      // the desktop connection needs its own key
      await th.ctx.updateSettings({ bfwConnection: 'desktop' });
      expect(bfwReady(th.ctx)).toBe(false);
      notifySecretsChange(secretStatusOf({ bfwDesktop: true }));
      expect(bfwReady(th.ctx)).toBe(true);
    } finally {
      stop();
    }
    expect(bfwReady(th.ctx)).toBe(false);
  });

  it('probe text reports read and ai access', async () => {
    const th = createTestHost();
    const answers = [
      { user: 'kim', read: true, ai: 'ok' },
      { user: 'lee', read: false, ai: 'noScope' },
      { user: 'park', read: true, ai: 'adminOnly' },
    ];
    const net = fakeInvoke({ secret_status: () => secretStatusOf({}), bfw_probe: () => answers.shift() });
    const stop = startBfworkflow(th.ctx, net.invoke);
    try {
      const probe = probeFor('bfw')!;
      expect(probe).toBeTruthy();
      const fields = { url: 'https://workflow.kbiofoundry.kr', connection: 'server', apiKey: 'typed' };
      expect(await probe(fields)).toEqual({ ok: true, message: t('bfw.probe.ok', 'kim', t('bfw.probe.yes'), t('bfw.probe.yes')) });
      expect(await probe(fields)).toEqual({ ok: true, message: t('bfw.probe.ok', 'lee', t('bfw.probe.no'), t('bfw.probe.ai.noScope')) });
      expect(await probe(fields)).toEqual({ ok: true, message: t('bfw.probe.ok', 'park', t('bfw.probe.yes'), t('bfw.probe.ai.adminOnly')) });
      const sent = net.calls.find(([c]) => c === 'bfw_probe')![1];
      expect(sent).toEqual({ connection: 'server', url: 'https://workflow.kbiofoundry.kr', apiKey: 'typed' });
    } finally {
      stop();
    }
    expect(probeFor('bfw')).toBeUndefined();
  });

  it('a failed probe gives the error sentence, never the raw Rust text', async () => {
    const th = createTestHost();
    const net = fakeInvoke({
      secret_status: () => secretStatusOf({}),
      bfw_probe: () => {
        throw netError('status', { status: 401 });
      },
    });
    const stop = startBfworkflow(th.ctx, net.invoke);
    try {
      const r = await probeFor('bfw')!({ url: 'https://workflow.kbiofoundry.kr', connection: 'server' });
      expect(r).toEqual({ ok: false, message: t('bfw.keyRefused') });
    } finally {
      stop();
    }
  });

  it('the bfw texts exist in ko and en', () => {
    for (const k of [
      'bfw.offline', 'bfw.keyRefused', 'bfw.noScope', 'bfw.rateLimited', 'bfw.notConfigured', 'bfw.desktopNotRunning',
      'bfw.failed', 'bfw.syncing', 'bfw.catalogsCurrent', 'bfw.catalogsConfirm', 'bfw.catalogsConfirmTitle', 'bfw.catalogsUpdated', 'bfw.apply', 'bfw.probe.ok',
      'bfw.probe.yes', 'bfw.probe.no', 'bfw.probe.ai.noScope', 'bfw.probe.ai.adminOnly', 'bfw.catalogBroken',
      'integrations.redirected', 'integrations.insecure', 'integrations.keychain', 'integrations.tooLarge', 'integrations.badRequest',
    ]) {
      expect(catalogs.ko[k], k).toBeTruthy();
      expect(catalogs.en[k], k).toBeTruthy();
    }
    expect(catalogs.en['bfw.catalogsConfirm']).toBe(
      'Update the vault catalogs from bfworkflow: {0} added, {1} changed, {2} vault-only kept, {3} skipped.',
    );
  });
});
