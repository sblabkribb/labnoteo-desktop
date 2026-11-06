import { readFileSync } from 'node:fs';
import { TauriLabnoteFs } from '../tauriLabnoteFs';
import { openVault, restoreVault } from '../../vault/useVault';
import { fetchTree } from '../../tree/useTree';

// 공유 픽스처. Rust 쪽 src-tauri/tests/ipc.rs 가 같은 파일을 읽어 커맨드가 이 이름을 받는지 본다.
const fixture: Record<string, string[]> = JSON.parse(
  readFileSync('src-tauri/tests/ipc-args.json', 'utf-8'),
);

/** 실제로 보낸 커맨드별 인자 이름(정렬)을 기록하는 가짜 invoke. */
function recorder() {
  const sent = new Map<string, string[]>();
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    sent.set(cmd, Object.keys(args ?? {}).sort());
    if (cmd === 'vault_modify') return { kind: 'ok' };
    if (cmd === 'vault_read') return 'old';
    if (cmd === 'vault_list') return [];
    if (cmd === 'vault_exists') return true;
    if (cmd === 'vault_open' || cmd === 'vault_current') return { root: 'D:\\lab', name: 'lab', hasObsidianConfig: false };
    return null;
  };
  return { sent, invoke: invoke as never };
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
    await fetchTree(r.invoke);
    await restoreVault(r.invoke);
    await openVault(r.invoke, 'D:\\lab');

    const expected = Object.fromEntries(Object.entries(fixture).map(([k, v]) => [k, [...v].sort()]));
    expect(Object.fromEntries(r.sent)).toEqual(expected);
  });
});
