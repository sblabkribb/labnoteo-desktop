import {
  BFW_DEFAULT_URL,
  fromPluginData,
  fromStored,
  isOriginUrl,
  isServiceUrl,
  loadVaultSettings,
  saveVaultSettings,
  type AppSettings,
} from '../settings';

type Calls = Array<[string, Record<string, unknown> | undefined]>;

/** Rust 쪽 저장소 흉내: settings_vault_write 가 쓴 글을 settings_vault_read 가 돌려준다. */
function fakeStore(opts: { stored?: string | null; plugin?: string | null; llmKey?: boolean } = {}) {
  let stored = opts.stored ?? null;
  const calls: Calls = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === 'settings_vault_read') return stored;
    if (cmd === 'settings_import_plugin') return opts.plugin ?? null;
    if (cmd === 'settings_plugin_llm_key') return opts.llmKey ?? false;
    if (cmd === 'settings_vault_write') {
      stored = String(args?.content);
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  };
  return { invoke: invoke as never, calls, stored: () => stored };
}

const count = (calls: Calls, cmd: string) => calls.filter(([c]) => c === cmd).length;

describe('보관함별 설정', () => {
  it('fromPluginData drops secrets: data.json 의 키와 값이 어디에도 남지 않는다', () => {
    const raw = {
      autoSyncUnitOpToc: false,
      customSampleTypes: ['Strain'],
      llmApiKey: 'sk-secret-openai',
      mcpToken: 'a'.repeat(48),
      partbankApiKey: 'pb-secret-key',
      llmEndpointOpenai: 'https://api.example.com',
    };
    const text = JSON.stringify(fromPluginData(raw));
    for (const s of ['llmApiKey', 'mcpToken', 'partbankApiKey', 'sk-secret-openai', 'a'.repeat(48), 'pb-secret-key']) {
      expect(text).not.toContain(s);
    }
    const s = fromPluginData(raw);
    expect(s.autoSyncUnitOpToc).toBe(false);
    expect(s.customSampleTypes).toEqual(['Strain']);
    expect(Object.keys(s).sort()).toEqual(
      [
        'allowHttpOrigins',
        'autoSyncUnitOpToc',
        'autoUpdateLastUpdated',
        'bfwConnection',
        'bfwUrl',
        'catalogNoticeHash',
        'customSampleTypes',
        'globalSampleFolder',
        'legacyNotesOfferDismissed',
        'llmEndpointOllama',
        'llmEndpointOpenai',
        'llmModel',
        'llmProvider',
        'partbankDefaultConnection',
        'partbankDesktopUrl',
        'partbankSendUsages',
        'partbankWebUrl',
        'sampleTracking',
        'schemaVersion',
        'workflowViewGroupBy',
      ].sort(),
    );
  });

  it('an unknown workflowViewGroupBy falls back to status (migrateSettings 를 거친다)', () => {
    expect(fromPluginData({ workflowViewGroupBy: 'colour' }).workflowViewGroupBy).toBe('status');
    expect(fromPluginData({ workflowViewGroupBy: 'project' }).workflowViewGroupBy).toBe('project');
    expect(fromPluginData(null).workflowViewGroupBy).toBe('status');
  });

  it('first load imports data.json once and saves: 두 번째 열기는 settings_import_plugin 을 부르지 않는다', async () => {
    const store = fakeStore({ plugin: JSON.stringify({ autoSyncUnitOpToc: false, llmApiKey: 'sk-secret' }) });
    const first = await loadVaultSettings(store.invoke);
    expect(first.imported).toBe(true);
    expect(first.settings.autoSyncUnitOpToc).toBe(false);
    expect(first.settings.importedFromPlugin).toBe(true);
    expect(count(store.calls, 'settings_import_plugin')).toBe(1);
    expect(count(store.calls, 'settings_vault_write')).toBe(1);
    expect(store.stored()).not.toContain('sk-secret');

    const second = await loadVaultSettings(store.invoke);
    expect(second.imported).toBe(false);
    expect(second.settings.autoSyncUnitOpToc).toBe(false);
    expect(count(store.calls, 'settings_import_plugin')).toBe(1);
  });

  it('data.json 이 없으면 기본값을 저장하고 가져오기로 알리지 않는다', async () => {
    const store = fakeStore();
    const { settings, imported } = await loadVaultSettings(store.invoke);
    expect(imported).toBe(false);
    expect(settings.autoSyncUnitOpToc).toBe(true);
    expect(settings.workflowViewGroupBy).toBe('status');
    expect(count(store.calls, 'settings_vault_write')).toBe(1);
    await loadVaultSettings(store.invoke);
    expect(count(store.calls, 'settings_import_plugin')).toBe(1);
  });

  it('a corrupt stored file falls back to defaults without throwing', async () => {
    for (const stored of ['{not json', '[]', 'null', '"text"', '7']) {
      const store = fakeStore({ stored });
      const { settings, imported } = await loadVaultSettings(store.invoke);
      expect(imported).toBe(false);
      expect(settings.workflowViewGroupBy).toBe('status');
      expect(settings.autoSyncUnitOpToc).toBe(true);
    }
    // 손상된 data.json 도 기본값이다.
    const broken = fakeStore({ plugin: '{oops' });
    await expect(loadVaultSettings(broken.invoke)).resolves.toMatchObject({ imported: false });
    // 저장소가 아예 응답하지 않아도 던지지 않는다.
    const failing = (async () => {
      throw { kind: 'noVault', message: 'no vault is open' };
    }) as never;
    await expect(loadVaultSettings(failing)).resolves.toMatchObject({ imported: false });
  });

  it('저장한 값은 다시 열 때 그대로 읽힌다 (비밀 키는 Pick 에 없어 저장되지 않는다)', async () => {
    const store = fakeStore();
    const { settings } = await loadVaultSettings(store.invoke);
    const next: AppSettings = { ...settings, workflowViewGroupBy: 'author', customSampleTypes: ['Plasmid'] };
    await saveVaultSettings({ ...next, llmApiKey: 'sk-leak' } as AppSettings, store.invoke);
    expect(store.stored()).not.toContain('sk-leak');
    const again = await loadVaultSettings(store.invoke);
    expect(again.settings.workflowViewGroupBy).toBe('author');
    expect(again.settings.customSampleTypes).toEqual(['Plasmid']);
  });

  it('legacyNotesOfferDismissed (app-only key) defaults to false and survives a save and reload', async () => {
    expect(fromPluginData(undefined).legacyNotesOfferDismissed).toBe(false);
    expect(fromPluginData({ legacyNotesOfferDismissed: true }).legacyNotesOfferDismissed).toBe(false); // not a plugin key
    const store = fakeStore();
    const { settings } = await loadVaultSettings(store.invoke);
    expect(settings.legacyNotesOfferDismissed).toBe(false);
    await saveVaultSettings({ ...settings, legacyNotesOfferDismissed: true }, store.invoke);
    expect(JSON.parse(store.stored()!).legacyNotesOfferDismissed).toBe(true);
    expect((await loadVaultSettings(store.invoke)).settings.legacyNotesOfferDismissed).toBe(true);
    // a stored non-boolean is the default
    const odd = fakeStore({ stored: JSON.stringify({ legacyNotesOfferDismissed: 'yes' }) });
    expect((await loadVaultSettings(odd.invoke)).settings.legacyNotesOfferDismissed).toBe(false);
  });

  it('integration settings get the plugin defaults, with usage sending off', () => {
    const s = fromPluginData({});
    expect(s).toMatchObject({ partbankDesktopUrl: 'http://127.0.0.1:47830', partbankWebUrl: 'https://partbank.kbiofoundry.kr',
      partbankDefaultConnection: 'web', partbankSendUsages: false, llmProvider: 'none', llmEndpointOllama: 'http://localhost:11434',
      llmEndpointOpenai: 'https://api.openai.com', llmModel: 'llama3.1', bfwUrl: 'https://workflow.kbiofoundry.kr', bfwConnection: 'server', allowHttpOrigins: [] });
  });

  it('usage sending is on only when the plugin data says true', () => {
    expect(fromPluginData({ partbankSendUsages: true }).partbankSendUsages).toBe(true);
    expect(fromPluginData({ partbankSendUsages: false }).partbankSendUsages).toBe(false);
    expect(fromPluginData(undefined).partbankSendUsages).toBe(false);
    expect(fromPluginData({ partbankSendUsages: 'true' }).partbankSendUsages).toBe(false);
  });

  it('an invalid bfwUrl or bfwConnection falls back', () => {
    expect(fromPluginData({ bfwUrl: 'ftp://x', bfwConnection: 'cloud' })).toMatchObject({ bfwUrl: BFW_DEFAULT_URL, bfwConnection: 'server' });
    expect(fromPluginData({ bfwUrl: 'https://w.example/sub' }).bfwUrl).toBe(BFW_DEFAULT_URL);
    expect(fromPluginData({ bfwUrl: 'https://w.example', bfwConnection: 'desktop' })).toMatchObject({ bfwUrl: 'https://w.example', bfwConnection: 'desktop' });
  });

  it('allowHttpOrigins keeps only http origins', () => {
    expect(fromStored({ allowHttpOrigins: ['http://10.0.0.5:8000', 'https://x', 'http://a/b', 3] }).allowHttpOrigins).toEqual(['http://10.0.0.5:8000']);
    expect(fromStored({ allowHttpOrigins: 'http://10.0.0.5:8000' }).allowHttpOrigins).toEqual([]);
  });

  it('the integration settings survive a save and reload', async () => {
    const store = fakeStore();
    const { settings } = await loadVaultSettings(store.invoke);
    await saveVaultSettings({ ...settings, llmProvider: 'openai', llmModel: 'gpt-x', partbankSendUsages: true, bfwConnection: 'desktop', allowHttpOrigins: ['http://10.0.0.5:8000'] }, store.invoke);
    expect((await loadVaultSettings(store.invoke)).settings).toMatchObject({ llmProvider: 'openai', llmModel: 'gpt-x', partbankSendUsages: true, bfwConnection: 'desktop', allowHttpOrigins: ['http://10.0.0.5:8000'] });
  });

  it('saveVaultSettings never writes a key-like field even if one is smuggled in', async () => {
    const f = fakeStore();
    await saveVaultSettings({ ...fromPluginData({}), llmApiKey: 'sk-1' } as never, f.invoke);
    expect(f.stored()).not.toContain('sk-1');
  });

  it('isServiceUrl and isOriginUrl', () => {
    expect(isServiceUrl('https://a.example')).toBe(true);
    expect(isServiceUrl('http://127.0.0.1:47830/api')).toBe(true);
    for (const v of ['ftp://a', 'https://u:p@a', 'https://a/?q', 'https://a/#f', '', 'a.example', 3, undefined]) expect(isServiceUrl(v)).toBe(false);
    expect(isOriginUrl('https://a.example/')).toBe(true);
    expect(isOriginUrl('https://a.example')).toBe(true);
    expect(isOriginUrl('https://a.example/x')).toBe(false);
  });

  it('loadVaultSettings reports a plugin LLM key only on the first import', async () => {
    const first = fakeStore({ plugin: '{}', llmKey: true });
    expect(await loadVaultSettings(first.invoke)).toMatchObject({ imported: true, foundLlmKey: true });
    expect(count(first.calls, 'settings_plugin_llm_key')).toBe(1);
    const again = await loadVaultSettings(first.invoke);
    expect(again).toMatchObject({ imported: false, foundLlmKey: false });
    expect(count(first.calls, 'settings_plugin_llm_key')).toBe(1);
    const none = fakeStore({ plugin: '{}', llmKey: false });
    expect(await loadVaultSettings(none.invoke)).toMatchObject({ imported: true, foundLlmKey: false });
    // a failing check is "no key found", never a thrown error
    const failing = fakeStore({ plugin: '{}' });
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'settings_plugin_llm_key') throw { kind: 'io', message: 'x' };
      return (failing.invoke as (c: string, a?: Record<string, unknown>) => Promise<unknown>)(cmd, args);
    }) as never;
    expect(await loadVaultSettings(invoke)).toMatchObject({ imported: true, foundLlmKey: false });
  });
});
