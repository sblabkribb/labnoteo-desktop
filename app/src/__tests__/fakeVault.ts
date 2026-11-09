import { MemFileSystem } from '@labnoteo/core';
import { ERROR_KINDS } from '../fs/errorKinds';
import type { VaultChange } from '../vault/useVaultEvents';
import { IMAGE_EXTS } from '../editor/live/imagePath';

/**
 * 테스트용 가짜 보관함: Tauri `invoke` 의 표면을 `MemFileSystem` 위에 Rust 와 같은 의미로 흉내 낸다.
 * - 없는 파일 읽기는 `{kind:'notFound'}`, `vault_modify` 는 기대값 비교(어긋나면 `{kind:'conflict', current}`),
 *   없는 폴더 목록은 `[]`, `vault_rename` 은 대상이 있으면 `exists`(대소문자만 다른 같은 항목은 허용),
 *   `vault_trash` 는 지운 것을 `recycleBin` 에 기록한다(영구 삭제가 아니다).
 * - 모든 호출은 `log` 에 남는다. `failNext(cmd, kind)` 는 그 커맨드의 다음 호출 한 번을 그 kind 로 거부한다.
 * - 경로는 Rust 가 받는 정규형(빈 문자열 = 루트, `/` 구분)으로 받는다고 가정한다.
 * Task 7–15 의 테스트가 다시 쓴다. `mockTauri()` 로 `@tauri-apps/api/*` 를 이것으로 바꿀 수 있다.
 */

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Handler = (e: { event: string; payload: VaultChange }) => void;

export interface TrashedEntry {
  path: string;
  /** 휴지통으로 간 파일들(경로 -> 내용). */
  files: Record<string, string>;
}

export interface FakeWindow {
  onCloseRequested(handler: (e: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
  /** 테스트가 창 닫기를 요청한다. 처리기가 preventDefault 하지 않았으면 destroyed 가 된다. */
  requestClose(): Promise<void>;
  destroyed: boolean;
}

export interface FakeVault {
  readonly mem: MemFileSystem;
  /** 지금 파일들(경로 -> 내용)의 사본. */
  files(): Record<string, string>;
  readonly log: { cmd: string; args: Record<string, unknown> }[];
  readonly recycleBin: TrashedEntry[];
  readonly invoke: InvokeFn;
  failNext(cmd: string, kind: string): void;
  listen(event: string, handler: Handler): Promise<() => void>;
  /** Rust 감시자가 보내는 `vault://changed` 를 흉내 낸다. */
  emitChange(path: string, kind: VaultChange['kind']): Promise<void>;
  readonly window: FakeWindow;
  /** 보관함별 설정(`settings_vault_*`). */
  settings: string | null;
  /** `settings_import_plugin` 이 돌려줄 data.json. */
  pluginData: string | null;
  /** 링크 고침 기록(`link_journal_*`). 보관함 밖에 있으므로 `files()` 에는 나오지 않는다. */
  journal: { header: string | null; notes: Map<number, string> };
}

const fail = (kind: string, message: string) => ({ kind, message });

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function createFakeVault(initial: Record<string, string> = {}): FakeVault {
  const mem = new MemFileSystem(initial);
  /** mkdir 로 만든 폴더. 파일이 있는 폴더는 파일 경로에서 따로 계산한다. */
  const madeDirs = new Set<string>();
  const log: FakeVault['log'] = [];
  const recycleBin: TrashedEntry[] = [];
  const failures = new Map<string, string[]>();
  const handlers = new Set<Handler>();
  const closeHandlers = new Set<(e: { preventDefault(): void }) => void | Promise<void>>();

  const files = () => mem.snapshot();
  const allDirs = (): Set<string> => {
    const out = new Set<string>();
    const add = (d: string) => {
      for (let x = d; x !== ''; x = parentOf(x)) out.add(x);
    };
    madeDirs.forEach(add);
    Object.keys(files()).forEach((f) => add(parentOf(f)));
    return out;
  };
  const isFile = (p: string) => p in files();
  const isDir = (p: string) => p === '' || allDirs().has(p);
  const under = (dir: string) => (p: string) => p.startsWith(`${dir}/`);
  /** NTFS 처럼 대소문자를 가리지 않는 존재 검사(rename 의 exists 규칙, vault_exists). */
  const existsAnyCase = (p: string) => {
    const l = p.toLowerCase();
    return p === '' || [...Object.keys(files()), ...allDirs()].some((x) => x.toLowerCase() === l);
  };

  const removeTree = (path: string): Record<string, string> => {
    const gone: Record<string, string> = {};
    for (const [p, c] of Object.entries(files())) {
      if (p === path || under(path)(p)) {
        gone[p] = c;
        void mem.remove(p);
      }
    }
    for (const d of [...madeDirs]) if (d === path || under(path)(d)) madeDirs.delete(d);
    return gone;
  };

  const vault = { root: 'C:/fake-vault', name: 'fake-vault', hasObsidianConfig: false };

  const fake: FakeVault = {
    mem,
    files,
    log,
    recycleBin,
    settings: null,
    pluginData: null,
    journal: { header: null, notes: new Map() },
    failNext(cmd, kind) {
      failures.set(cmd, [...(failures.get(cmd) ?? []), kind]);
    },
    async listen(_event, handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    async emitChange(path, kind) {
      for (const h of [...handlers]) h({ event: 'vault://changed', payload: { path, kind } });
      await Promise.resolve();
    },
    window: {
      destroyed: false,
      async onCloseRequested(handler) {
        closeHandlers.add(handler);
        return () => void closeHandlers.delete(handler);
      },
      async destroy() {
        fake.window.destroyed = true;
      },
      async requestClose() {
        let prevented = false;
        for (const h of [...closeHandlers]) await h({ preventDefault: () => (prevented = true) });
        if (!prevented) fake.window.destroyed = true;
      },
    },
    invoke: (async (cmd: string, args: Record<string, unknown> = {}) => {
      log.push({ cmd, args });
      const queued = failures.get(cmd);
      if (queued?.length) {
        const kind = queued.shift()!;
        throw fail(kind, `injected ${kind} for ${cmd}`);
      }
      const path = args.path as string;
      switch (cmd) {
        case 'app_version':
          return '0.0.0-test';
        case 'vault_open':
        case 'vault_create':
        case 'vault_current':
          return vault;
        case 'vault_tree': {
          const dirs = allDirs();
          const out: { path: string; name: string; isDir: boolean; depth: number }[] = [];
          const hidden = (n: string) => n.startsWith('.') || n.toLowerCase() === 'node_modules';
          const walk = (dir: string, depth: number) => {
            const kids = (set: Iterable<string>) =>
              [...set]
                .filter((p) => parentOf(p) === dir && !hidden(p.slice(p.lastIndexOf('/') + 1)))
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            for (const d of kids(dirs)) {
              out.push({ path: d, name: d.slice(d.lastIndexOf('/') + 1), isDir: true, depth });
              walk(d, depth + 1);
            }
            for (const f of kids(Object.keys(files()).filter((p) => /.\.md$/i.test(p)))) {
              out.push({ path: f, name: f.slice(f.lastIndexOf('/') + 1), isDir: false, depth });
            }
          };
          walk('', 0);
          return out;
        }
        case 'vault_read': {
          if (!isFile(path)) throw fail(ERROR_KINDS.notFound, `not found: ${path}`);
          return mem.read(path);
        }
        case 'vault_write':
          await mem.write(path, args.content as string);
          return undefined;
        case 'vault_modify': {
          const current = files()[path] ?? '';
          const expected = args.expectedBefore as string | undefined;
          if (expected !== undefined && expected !== current) return { kind: 'conflict', current };
          await mem.write(path, args.content as string);
          return { kind: 'ok' };
        }
        case 'vault_exists':
          return existsAnyCase(path);
        case 'vault_mkdir':
          madeDirs.add(path);
          return undefined;
        case 'vault_list': {
          const dir = args.dir as string;
          if (!isDir(dir)) return [];
          const names = new Set<string>();
          for (const p of [...Object.keys(files()), ...allDirs()]) {
            if (dir === '' || under(dir)(p)) {
              const rest = dir === '' ? p : p.slice(dir.length + 1);
              if (rest) names.add(rest.split('/')[0]);
            }
          }
          return [...names].sort();
        }
        case 'vault_remove':
          await mem.remove(path);
          return undefined;
        case 'vault_rmdir': {
          const busy = [...Object.keys(files()), ...allDirs()].some(under(path));
          if (!busy) madeDirs.delete(path);
          return undefined;
        }
        case 'vault_rename': {
          const from = args.from as string;
          const to = args.to as string;
          const fromIsFile = isFile(from);
          if (!fromIsFile && !isDir(from)) throw fail(ERROR_KINDS.notFound, `not found: ${from}`);
          const sameEntry = from.toLowerCase() === to.toLowerCase();
          if (!sameEntry && to.toLowerCase().startsWith(`${from.toLowerCase()}/`)) {
            throw fail(ERROR_KINDS.io, 'a folder can not be moved into itself');
          }
          if (!sameEntry && existsAnyCase(to)) throw fail(ERROR_KINDS.exists, `exists: ${to}`);
          // 빈 하위 폴더도 함께 옮긴다(NTFS 처럼)
          const emptyDirs = [...madeDirs].filter((d) => under(from)(d)).map((d) => to + d.slice(from.length));
          const moved = removeTree(from);
          for (const [p, c] of Object.entries(moved)) await mem.write(to + p.slice(from.length), c);
          if (!fromIsFile && Object.keys(moved).length === 0) madeDirs.add(to);
          emptyDirs.forEach((d) => madeDirs.add(d));
          return undefined;
        }
        case 'vault_trash': {
          if (!isFile(path) && !isDir(path)) return undefined;
          recycleBin.push({ path, files: removeTree(path) });
          return undefined;
        }
        case 'index_rebuild':
          return { indexed: 0, skipped: 0 };
        case 'index_upsert':
        case 'index_remove':
          return undefined;
        case 'search':
          return { hits: [], truncated: false };
        case 'index_bodies': {
          // Rust 처럼 키(소문자 경로) 순서로, `after` 키 다음부터, 꽉 찬 쪽이면 마지막 키를 next 로.
          const after = (args.after as string | null) ?? null;
          const limit = Math.min(Math.max(Number(args.limit) || 1, 1), 500);
          const notes = Object.entries(files())
            .filter(([p]) => /.\.md$/i.test(p))
            .map(([p, body]) => ({ key: p.toLowerCase(), path: p, body }))
            .filter((n) => after === null || n.key > after)
            .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
            .slice(0, limit);
          return {
            items: notes.map(({ path: p, body }) => ({ path: p, body })),
            next: notes.length === limit ? notes[notes.length - 1].key : null,
          };
        }
        case 'vault_list_images': {
          const ext = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
          return Object.keys(files())
            .filter((p) => p.includes('.') && IMAGE_EXTS.includes(ext(p)))
            .sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0));
        }
        case 'settings_vault_read':
          return fake.settings;
        case 'settings_vault_write':
          fake.settings = args.content as string;
          return undefined;
        case 'settings_import_plugin':
          return fake.pluginData;
        case 'link_journal_read': {
          // Rust 처럼 header.json 이 없으면 null, 기록은 n 오름차순.
          const j = fake.journal;
          if (j.header === null) return null;
          return { header: j.header, notes: [...j.notes.entries()].sort(([x], [y]) => x - y).map(([, c]) => c) };
        }
        case 'link_journal_write_header':
          fake.journal.header = args.content as string;
          return undefined;
        case 'link_journal_write_note':
          fake.journal.notes.set(Number(args.n), args.content as string);
          return undefined;
        case 'link_journal_clear':
          fake.journal.header = null;
          fake.journal.notes.clear();
          return undefined;
        default:
          throw new Error(`fakeVault: unexpected command ${cmd}`);
      }
    }) as InvokeFn,
  };
  return fake;
}

let active: FakeVault | undefined;

/** `mockTauri()` 가 가리킬 가짜 보관함을 정한다(테스트마다 새로). */
export function installFakeVault(initial: Record<string, string> = {}): FakeVault {
  active = createFakeVault(initial);
  return active;
}

function current(): FakeVault {
  if (!active) throw new Error('fakeVault: call installFakeVault() first');
  return active;
}

/**
 * `vi.mock` 의 팩토리에 넘길 모듈 모양. 호출할 때마다 `installFakeVault` 로 깐 보관함으로 간다:
 *   vi.mock('@tauri-apps/api/core', async () => (await import('../__tests__/fakeVault')).mockTauri().core);
 *   vi.mock('@tauri-apps/api/event', async () => (await import('../__tests__/fakeVault')).mockTauri().event);
 *   vi.mock('@tauri-apps/api/window', async () => (await import('../__tests__/fakeVault')).mockTauri().window);
 */
export function mockTauri() {
  return {
    core: { invoke: ((cmd: string, args?: Record<string, unknown>) => current().invoke(cmd, args)) as InvokeFn },
    event: {
      listen: (event: string, handler: Handler) => current().listen(event, handler),
      emit: async (_event: string, payload: VaultChange) => current().emitChange(payload.path, payload.kind),
    },
    window: { getCurrentWindow: () => current().window },
  };
}
