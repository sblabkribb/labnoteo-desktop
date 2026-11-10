import { readFileSync } from 'node:fs';
import { TauriLabnoteFs } from '../tauriLabnoteFs';
import { createVault, openVault, restoreVault } from '../../vault/useVault';
import { fetchTree } from '../../tree/useTree';
import { fetchAppVersion } from '../../appVersion';
import { indexBodies, rebuildIndex, removeNote, searchNotes, searchNotesIn, upsertNote } from '../../search/indexApi';
import { loadVaultSettings, saveVaultSettings } from '../../labnote/settings';
import { listVaultImages, readVaultBytes, readVaultImage, vaultCreatedTimes, writeScanImage, writeVaultAttachment, writeVaultImage } from '../vaultImage';
import { fileInfo, openWithDefaultApp, revealInFolder } from '../vaultOpen';
import { clearLinkJournal, readLinkJournal, writeLinkJournalHeader, writeLinkJournalNote } from '../../links/journalIpc';
import { offerPluginLlmKey } from '../../integrations/importLlmKey';
import * as net from '../../integrations/netIpc';
import { deleteImportedFile, importConnectionsBytes, importConnectionsFile } from '../../integrations/importFile';
import { openInBrowser } from '../../labnote/print/openInBrowser';
import * as scan from '../../labnote/scan/scanIpc';
import * as mcp from '../../labnote/mcp/mcpIpc';
import { readClipboardLink } from '../../partbank/clipboardIpc';
import { DEFAULT_PREFS, readUiPrefs, writeUiPrefs } from '../../ui/layoutStore';
import { skillInstall, skillSaveAs, skillStatus } from '../../labnote/skill/skillIpc';

// 공유 픽스처. Rust 쪽 src-tauri/tests/ipc.rs 가 같은 파일을 읽어 커맨드가 이 이름을 받는지 본다.
const fixture: Record<string, string[]> = JSON.parse(
  readFileSync('src-tauri/tests/ipc-args.json', 'utf-8'),
);

/**
 * 픽스처에는 있지만 아직 TypeScript 래퍼가 없는 커맨드. SP6 Task 11 이 netIpc.ts 래퍼로 비웠다.
 * 래퍼가 생긴 커맨드를 여기 남겨 두면(또는 픽스처에 없는 이름을 두면) 마지막 테스트가 실패한다.
 * SP7 Part B: 스캔 폴더 커맨드 아홉 개는 Task 18 이 scanIpc.ts 래퍼로 비웠다.
 * SP7 Part C 의 mcp_* 커맨드 아홉은 Task 36 의 mcpIpc.ts 래퍼로 비웠다.
 */
const PENDING_TS_WRAPPERS: readonly string[] = [
  // feat/github-upload: Task 1 이 Rust 커맨드를 등록했다. githubIpc.ts 래퍼는 Task 11 이 만들며 이 목록을 비운다.
  'github_app_settings_get',
  'github_app_settings_set',
  // Task 3: 로그인(기기 코드), 토큰 붙여넣기, 계정, 로그아웃.
  'github_sign_in_start',
  'github_sign_in_wait',
  'github_account',
  'github_sign_out',
  'github_set_token',
  // Task 4: 올릴 곳(계정·조직) 목록, 저장소 이름 확인, 기존 저장소 주소 확인.
  'github_owners',
  'github_name_check',
  'github_resolve_repo',
  // Task 7: 올릴 파일 확인(계획). 네트워크를 쓰지 않는다.
  'github_plan',
  // Task 9A: 올리기, 폴더 상태, 기본 올릴 곳, 연결 끊기(올리기 말고는 네트워크를 쓰지 않는다).
  'github_upload',
  'github_folder_status',
  'github_statuses',
  'github_default_owner_get',
  'github_default_owner_set',
  'github_unlink',
  // Task 9C: 끝나지 않은 올리기 마저 하기.
  'github_retry',
];

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
    if (cmd === 'vault_write_attachment') return 'exp/resources/plate.csv';
    if (cmd === 'scan_write_image') return 'e/images/scans/LN-7K3M9QX2_u1_p1_20261015.jpg';
    if (cmd === 'vault_modify') return { kind: 'ok' };
    if (cmd === 'vault_read') return 'old';
    if (cmd === 'vault_list' || cmd === 'search') return [];
    if (cmd === 'vault_exists') return true;
    if (cmd === 'settings_import_plugin') return '{}';
    if (cmd === 'settings_plugin_llm_key') return true;
    if (cmd === 'integration_import_pick') return null;
    if (cmd === 'integration_import_bytes') return { status: 'refused', reason: 'wrongType' };
    if (cmd === 'integration_import_delete') return 'gone';
    if (cmd === 'vault_read_image' || cmd === 'vault_read_bytes') return new ArrayBuffer(0);
    if (cmd === 'vault_list_images') return [];
    if (cmd === 'vault_created_times') return [null];
    if (cmd === 'slack_call') return { status: 200, json: { ok: true } };
    if (cmd === 'slack_download') return new ArrayBuffer(0);
    if (cmd === 'scan_folder_list') return [];
    if (cmd === 'scan_folder_prune_baseline') return ['a|1|2'];
    if (cmd === 'scan_folder_read') return new ArrayBuffer(0);
    if (cmd === 'scan_folder_move') return 'labnote-processed/a.jpg';
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
    await searchNotesIn('q', 'labnote/001_A', 10, r.invoke);
    await indexBodies(null, 1, r.invoke);
    await openVault(r.invoke, 'D:\\lab');
    await createVault(r.invoke, 'D:\\lab');
    const { settings } = await loadVaultSettings(r.invoke);
    await saveVaultSettings(settings, r.invoke);
    await offerPluginLlmKey({ confirm: async () => true, notify: () => undefined }, r.invoke);
    expect(await readVaultImage('a.png', r.invoke)).toBeInstanceOf(ArrayBuffer);
    expect(await readVaultBytes('a.csv', r.invoke)).toBeInstanceOf(ArrayBuffer);
    expect(await listVaultImages(r.invoke)).toEqual([]);
    await openWithDefaultApp('a.pdf', r.invoke);
    await revealInFolder('a.pdf', r.invoke);
    await fileInfo('a.pdf', r.invoke);
    expect(await writeVaultImage('exp/images', 'p.png', new Uint8Array([1]), r.invoke)).toBe('exp/images/p.png');
    expect(await writeVaultAttachment('exp/resources', 'plate.csv', new Uint8Array([1]), r.invoke)).toBe('exp/resources/plate.csv');
    expect(await writeScanImage('e/images/scans', 'LN-7K3M9QX2_u1_p1_20261015.jpg', new Uint8Array([1]), r.invoke)).toBe(
      'e/images/scans/LN-7K3M9QX2_u1_p1_20261015.jpg',
    );
    expect(await vaultCreatedTimes(['a.md'], r.invoke)).toEqual([null]);
    await openInBrowser('note', 'LN-7K3M9QX2', '<p>', r.invoke);
    expect(await readLinkJournal(r.invoke)).toBeNull();
    await writeLinkJournalHeader('{}', r.invoke);
    await writeLinkJournalNote(0, '{}', r.invoke);
    await clearLinkJournal(r.invoke);
    // SP6 net 커맨드: 래퍼마다 한 번씩
    await net.secretStatus(r.invoke);
    await net.setSecret('partbankWeb', 'v', r.invoke);
    await net.clearSecret('partbankWeb', r.invoke);
    expect(await importConnectionsFile('Choose', r.invoke)).toBeNull();
    await importConnectionsBytes('conn.env', new Uint8Array([1]), r.invoke);
    await deleteImportedFile(false, r.invoke);
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
    // SP7 Part B Slack 커맨드
    await net.slackCall({ method: 'authTest' }, r.invoke);
    expect(await net.slackDownload({ url: 'https://files.slack.com/files-pri/T1-F1/a.png' }, r.invoke)).toBeInstanceOf(ArrayBuffer);
    // SP7 Part B 스캔 폴더 커맨드: 래퍼마다 한 번씩
    await scan.scanFolderChoose(r.invoke);
    await scan.scanFolderClear(r.invoke);
    await scan.scanFolderSetMode('shared', r.invoke);
    await scan.scanFolderStatus(r.invoke);
    expect(await scan.scanFolderList(r.invoke)).toEqual([]);
    expect(await scan.scanFolderPruneBaseline(['a|1|2'], r.invoke)).toEqual(['a|1|2']);
    expect(await scan.scanFolderRead('a.jpg', r.invoke)).toBeInstanceOf(ArrayBuffer);
    expect(await scan.scanFolderMove('a.jpg', 'processed', r.invoke)).toBe('labnote-processed/a.jpg');
    await scan.scanFolderWatch(r.invoke);
    // SP7 Part C MCP 커맨드: 래퍼마다 한 번씩
    await mcp.mcpTokenStatus(r.invoke);
    await mcp.mcpTokenRegenerate(r.invoke);
    await mcp.mcpTokenCopy(r.invoke);
    await mcp.mcpStart(3987, [{ name: 'read_section', description: 'd', inputSchema: {}, mutates: false }], r.invoke);
    await mcp.mcpStop(r.invoke);
    await mcp.mcpStatus(r.invoke);
    await mcp.mcpClaim('c1', r.invoke);
    await mcp.mcpReply('c1', { kind: 'noReply' }, r.invoke);
    await mcp.mcpDrain(r.invoke);
    await readClipboardLink(r.invoke);
    expect(await readUiPrefs(r.invoke)).toEqual(DEFAULT_PREFS);
    await writeUiPrefs({ ...DEFAULT_PREFS }, r.invoke);
    // SKILL.md 설치: 내용이나 경로는 보내지 않는다
    await skillStatus(r.invoke);
    await skillInstall(false, r.invoke);
    await skillSaveAs(r.invoke);

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

  it('writeScanImage 는 vault_write_image 와 같은 원시 본문과 퍼센트 인코딩 헤더로 정확한 이름을 보낸다', async () => {
    const r = recorder();
    const bytes = new Uint8Array([7, 8]);
    let body: unknown;
    const invoke = (async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
      body = args;
      return (r.invoke as (c: string, a?: unknown, o?: unknown) => Promise<unknown>)(cmd, args, options);
    }) as never;
    await writeScanImage('실험/images/scans', 'LN-7K3M9QX2_u1_p1_20261015_2.jpg', bytes, invoke);
    expect(body).toBe(bytes);
    expect(r.headers.get('scan_write_image')).toEqual({
      'x-lno-dir': '%EC%8B%A4%ED%97%98%2Fimages%2Fscans',
      'x-lno-name': 'LN-7K3M9QX2_u1_p1_20261015_2.jpg',
    });
  });

  it('writeVaultImage 는 바이트를 원시 본문으로, 폴더와 이름은 퍼센트 인코딩한 헤더로 보낸다', async () => {
    const r = recorder();
    await writeVaultImage('실험/images', '붙여 넣기.png', new Uint8Array([1, 2]), r.invoke);
    expect(r.headers.get('vault_write_image')).toEqual({
      'x-lno-dir': '%EC%8B%A4%ED%97%98%2Fimages',
      'x-lno-name': '%EB%B6%99%EC%97%AC%20%EB%84%A3%EA%B8%B0.png',
    });
  });

  it('writeVaultAttachment 는 writeVaultImage 와 같은 원시 본문과 퍼센트 인코딩 헤더로 보낸다', async () => {
    const r = recorder();
    await writeVaultAttachment('실험/resources', '결과 1.csv', new Uint8Array([1, 2]), r.invoke);
    expect(r.headers.get('vault_write_attachment')).toEqual({
      'x-lno-dir': '%EC%8B%A4%ED%97%98%2Fresources',
      'x-lno-name': '%EA%B2%B0%EA%B3%BC%201.csv',
    });
  });
});
