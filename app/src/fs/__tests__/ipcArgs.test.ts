import { readFileSync } from 'node:fs';
import { TauriLabnoteFs } from '../tauriLabnoteFs';
import { createVault, openVault, restoreVault } from '../../vault/useVault';
import { fetchTree } from '../../tree/useTree';
import { fetchAppVersion } from '../../appVersion';
import { indexBodies, rebuildIndex, removeNote, searchNotes, upsertNote } from '../../search/indexApi';
import { loadVaultSettings, saveVaultSettings } from '../../labnote/settings';
import { listVaultImages, readVaultImage, vaultCreatedTimes, writeVaultImage } from '../vaultImage';
import { clearLinkJournal, readLinkJournal, writeLinkJournalHeader, writeLinkJournalNote } from '../../links/journalIpc';
import { offerPluginLlmKey } from '../../integrations/importLlmKey';
import * as net from '../../integrations/netIpc';

// 공유 픽스처. Rust 쪽 src-tauri/tests/ipc.rs 가 같은 파일을 읽어 커맨드가 이 이름을 받는지 본다.
const fixture: Record<string, string[]> = JSON.parse(
  readFileSync('src-tauri/tests/ipc-args.json', 'utf-8'),
);

/**
 * 픽스처에는 있지만 아직 TypeScript 래퍼가 없는 커맨드. SP6 Task 11 이 netIpc.ts 래퍼로 비웠다.
 * 래퍼가 생긴 커맨드를 여기 남겨 두면(또는 픽스처에 없는 이름을 두면) 마지막 테스트가 실패한다.
 */
const PENDING_TS_WRAPPERS: readonly string[] = [];

/**
 * 실제로 보낸 커맨드별 인자 이름(정렬)을 기록하는 가짜 invoke.
 * 본문이 원시 바이트(Uint8Array)면 인자 이름 대신 헤더 이름을 기록한다.
 */
function recorder() {
  const sent = new Map<string, string[]>();
  const headers = new Map<string, Record<string, string>>();
  const invoke = async (
    cmd: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ) => {
    if (args instanceof Uint8Array) {
      sent.set(cmd, Object.keys(options?.headers ?? {}).sort());
      headers.set(cmd, options?.headers ?? {});
    } else {
      sent.set(cmd, Object.keys(args ?? {}).sort());
    }
    if (cmd === 'vault_write_image') return 'exp/images/p.png';
    if (cmd === 'vault_modify') return { kind: 'ok' };
    if (cmd === 'vault_read') return 'old';
    if (cmd === 'vault_list' || cmd === 'search') return [];
    if (cmd === 'vault_exists') return true;
    if (cmd === 'settings_import_plugin') return '{}';
    if (cmd === 'settings_plugin_llm_key') return true;
    if (cmd === 'vault_read_image') return new ArrayBuffer(0);
    if (cmd === 'vault_list_images') return [];
    if (cmd === 'vault_created_times') return [null];
    if (cmd === 'index_bodies') return { items: [], next: null };
    if (cmd === 'vault_open' || cmd === 'vault_create' || cmd === 'vault_current') return { root: 'D:\\lab', name: 'lab', hasObsidianConfig: false };
    return null;
  };
  return { sent, headers, invoke: invoke as never };
}

describe('IPC 인자 이름 계약', () => {
  it('TypeScript 가 보내는 인자 이름이 공유 픽스처와 정확히 같다', async () => {
    const r = recorder();
    const fs = new TauriLabnoteFs(r.invoke);
    await fs.read('a.md');
    await fs.write('a.md', 'x');
    await fs.modify('a.md', (d) => d + '!');
    await fs.exists('a.md');
    await fs.mkdir('d');
    await fs.list('d');
    await fs.remove('a.md');
    await fs.rmdir('d');
    await fs.rename('a.md', 'b.md');
    await fs.trash('a.md');
    await fetchTree(r.invoke);
    await restoreVault(r.invoke);
    await fetchAppVersion(r.invoke);
    await rebuildIndex(r.invoke);
    await upsertNote('a.md', r.invoke);
    await removeNote('a.md', r.invoke);
    await searchNotes('q', 10, r.invoke);
    await indexBodies(null, 1, r.invoke);
    await openVault(r.invoke, 'D:\\lab');
    await createVault(r.invoke, 'D:\\lab');
    const { settings } = await loadVaultSettings(r.invoke);
    await saveVaultSettings(settings, r.invoke);
    await offerPluginLlmKey({ confirm: async () => true, notify: () => undefined }, r.invoke);
    expect(await readVaultImage('a.png', r.invoke)).toBeInstanceOf(ArrayBuffer);
    expect(await listVaultImages(r.invoke)).toEqual([]);
    expect(await writeVaultImage('exp/images', 'p.png', new Uint8Array([1]), r.invoke)).toBe('exp/images/p.png');
    expect(await vaultCreatedTimes(['a.md'], r.invoke)).toEqual([null]);
    expect(await readLinkJournal(r.invoke)).toBeNull();
    await writeLinkJournalHeader('{}', r.invoke);
    await writeLinkJournalNote(0, '{}', r.invoke);
    await clearLinkJournal(r.invoke);
    // SP6 net 커맨드: 래퍼마다 한 번씩
    await net.secretStatus(r.invoke);
    await net.setSecret('partbankWeb', 'v', r.invoke);
    await net.clearSecret('partbankWeb', r.invoke);
    await net.partbankRequest({ connection: 'web', method: 'GET', path: '/auth/me' }, r.invoke);
    await net.partbankProbe({ connection: 'desktop', url: 'http://127.0.0.1:47830' }, r.invoke);
    const pending = new AbortController();
    const chat = net.llmChat({ provider: 'openai', body: {}, signal: pending.signal }, r.invoke);
    pending.abort(); // 아직 끝나지 않은 요청을 취소하면 net_cancel 이 간다
    await chat.catch(() => undefined);
    await net.llmProbe({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'm' }, r.invoke);
    await net.bfwRequest({ path: '/api/auth/me' }, r.invoke);
    await net.bfwProbe({ connection: 'server' }, r.invoke);
    await net.bfwBase(r.invoke);
    const listen = (async () => () => undefined) as unknown as net.ListenFn;
    await net.bfwGenerateNotes({ design: {}, language: 'ko', perWorkflow: false, onProgress: () => undefined }, r.invoke, listen);
    await net.partbankCatalogList(r.invoke);
    await net.partbankCatalogRead('a.json', r.invoke);
    await net.partbankCatalogWrite('a.json', '{}', r.invoke);
    await net.integrationStateRead('partbankUsage', r.invoke);
    await net.integrationStateWrite('partbankUsage', '{}', r.invoke);

    const expected = Object.fromEntries(
      Object.entries(fixture)
        .filter(([k]) => !PENDING_TS_WRAPPERS.includes(k))
        .map(([k, v]) => [k, [...v].sort()]),
    );
    expect(Object.fromEntries(r.sent)).toEqual(expected);
    // 아직 래퍼가 없다고 적어 둔 커맨드를 실제로는 보냈다면 목록이 낡은 것이다.
    for (const cmd of PENDING_TS_WRAPPERS) expect(r.sent.has(cmd)).toBe(false);
  });

  it('래퍼 대기 목록은 픽스처에 있는 커맨드만 담는다', () => {
    for (const cmd of PENDING_TS_WRAPPERS) expect(Object.keys(fixture)).toContain(cmd);
  });

  it('writeVaultImage 는 바이트를 원시 본문으로, 폴더와 이름은 퍼센트 인코딩한 헤더로 보낸다', async () => {
    const r = recorder();
    await writeVaultImage('실험/images', '붙여 넣기.png', new Uint8Array([1, 2]), r.invoke);
    expect(r.headers.get('vault_write_image')).toEqual({
      'x-lno-dir': '%EC%8B%A4%ED%97%98%2Fimages',
      'x-lno-name': '%EB%B6%99%EC%97%AC%20%EB%84%A3%EA%B8%B0.png',
    });
  });
});
