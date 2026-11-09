/**
 * 앱 데이터의 PartBank 카탈로그를 보관함 Global 폴더 안의 파일처럼 보이게 하는 덧씌우기(D15).
 *
 * 내려받은 `{Type}_partbank-(web|desktop).json` 은 앱 데이터(`integrations/partbank/<vault key>/`)에 있다. 샘플 흐름의 fs 를
 * `withPartbankCatalogs` 로 감싸면 코어의 `{Type}_*.json` 읽기(`@` 의 Search catalog, 정의 찾기, 동기화의 시드)가 네트워크 없이
 * 그대로 그것을 읽는다. 같은 이름의 보관함 파일은 앱 데이터 쪽이 가린다. 저장소가 고장 나면(names/read 거절)
 * 카탈로그가 없는 것으로 보고 보관함으로 넘긴다: 앱 데이터 폴더가 망가져도 `@` 와 샘플 저장소는 멈추지 않는다.
 */
import type { AppFs } from '../fs/tauriLabnoteFs';
import { partbankCatalogList, partbankCatalogRead, partbankCatalogWrite, type InvokeFn } from '../integrations/netIpc';

export interface PartbankCatalogStore {
  names(): Promise<string[]>;
  read(name: string): Promise<string | undefined>;
  write(name: string, content: string): Promise<void>;
  subscribe(fn: () => void): () => void;
}

function notifyAll(subs: Set<() => void>): void {
  for (const fn of [...subs]) {
    try {
      fn();
    } catch (e) {
      console.error('[partbank catalogs] listener failed', e);
    }
  }
}

/** Rust 의 `partbank_catalog_*` 위의 저장소. 이름 목록은 기억하고, write 가 잊게 한 뒤 알린다. 거절된 목록은 기억하지 않는다. */
export function tauriCatalogStore(invoke?: InvokeFn): PartbankCatalogStore {
  const subs = new Set<() => void>();
  let cached: Promise<string[]> | undefined;
  return {
    names() {
      if (!cached) {
        const p = partbankCatalogList(invoke);
        cached = p;
        p.catch(() => {
          if (cached === p) cached = undefined;
        });
      }
      return cached;
    },
    async read(name) {
      const text = await partbankCatalogRead(name, invoke);
      return text ?? undefined;
    },
    async write(name, content) {
      try {
        await partbankCatalogWrite(name, content, invoke);
      } finally {
        // 실패한 쓰기도 일부가 남았을 수 있다: 목록을 다시 읽게 한다
        cached = undefined;
      }
      notifyAll(subs);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

/** 카탈로그가 하나도 없는 저장소. `startPartbank`(Task 26)가 진짜 저장소를 놓기 전과 테스트의 기본값이다. */
export const emptyCatalogStore: PartbankCatalogStore = {
  names: async () => [],
  read: async () => undefined,
  write: async () => {
    throw new Error('no partbank catalog store');
  },
  subscribe: () => () => undefined,
};

let current: PartbankCatalogStore = emptyCatalogStore;
const swapListeners = new Set<() => void>();

/** 지금 앱이 쓰는 카탈로그 저장소. 놓기 전에는 `emptyCatalogStore`. */
export function currentCatalogStore(): PartbankCatalogStore {
  return current;
}

/** 앱의 카탈로그 저장소를 바꾼다(undefined 면 빈 저장소). 바뀐 것도 카탈로그 변경으로 알린다. */
export function setPartbankCatalogStore(store: PartbankCatalogStore | undefined): void {
  const next = store ?? emptyCatalogStore;
  if (next === current) return;
  current = next;
  notifyAll(swapListeners);
}

/**
 * 지금 저장소의 변경과 저장소 바꿈을 모두 듣는다. 저장소가 바뀌면 옛 저장소의 구독을 풀고 새 것을 구독한다.
 * 돌려준 함수가 둘 다 푼다.
 */
export function subscribeCurrentCatalogs(fn: () => void): () => void {
  let offStore = current.subscribe(fn);
  const onSwap = () => {
    offStore();
    offStore = current.subscribe(fn);
    fn();
  };
  swapListeners.add(onSwap);
  return () => {
    swapListeners.delete(onSwap);
    offStore();
  };
}

/** 지금 저장소에 부를 때마다 넘기는 저장소. 저장소가 바뀌어도 감싼 fs 의 정체성이 그대로여야 하는 곳(샘플 저장소)이 쓴다. */
export const liveCatalogStore: PartbankCatalogStore = {
  names: () => current.names(),
  read: (name) => current.read(name),
  write: (name, content) => current.write(name, content),
  subscribe: (fn) => subscribeCurrentCatalogs(fn),
};

/** 보관함 상대 경로의 비교용 모양: `\` → `/`, `./` 와 빈 조각을 지우고, 앞뒤 `/` 를 뗀다. */
function canon(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

const sameFolder = (a: string, b: string) => canon(a).toLowerCase() === canon(b).toLowerCase();

const readOnly = () => new Error('read-only partbank catalog');

/**
 * `fs` 위에 앱 데이터의 카탈로그를 덧씌운다(D15):
 * - `list(globalFolder())` 에 저장소의 이름을 더한다(겹치는 이름은 한 번);
 * - `<globalFolder>/<저장소 이름>` 의 `read`·`exists` 는 저장소가 답한다(같은 이름의 보관함 파일을 가린다).
 *   Global 폴더 자체의 `exists` 는 카탈로그가 있으면 참이다(코어 로더가 폴더부터 묻는다);
 * - 그 경로의 `write`·`modify`·`remove`·`rename`(어느 쪽이든)·`trash` 는 `Error('read-only partbank catalog')`;
 * - 나머지는 그대로 넘긴다. 저장소가 거절하면 카탈로그가 없는 것으로 본다.
 */
export function withPartbankCatalogs(fs: AppFs, globalFolder: () => string, store: PartbankCatalogStore): AppFs {
  const safeNames = async (): Promise<string[]> => {
    try {
      return await store.names();
    } catch {
      return [];
    }
  };
  /** `path` 가 Global 폴더 바로 안의 파일이면 그 이름. */
  const nameIn = (path: string): string | undefined => {
    const p = canon(path);
    const slash = p.lastIndexOf('/');
    const dir = slash < 0 ? '' : p.slice(0, slash);
    return sameFolder(dir, globalFolder()) ? p.slice(slash + 1) : undefined;
  };
  /** 저장소가 가진 카탈로그 경로면 그 이름. */
  const catalogName = async (path: string): Promise<string | undefined> => {
    const name = nameIn(path);
    if (name === undefined) return undefined;
    return (await safeNames()).includes(name) ? name : undefined;
  };
  const guard = async (...paths: string[]) => {
    for (const p of paths) if ((await catalogName(p)) !== undefined) throw readOnly();
  };

  return {
    async read(p) {
      const name = await catalogName(p);
      if (name !== undefined) {
        try {
          const text = await store.read(name);
          if (text !== undefined) return text;
        } catch {
          // 저장소가 읽지 못하면 보관함으로
        }
      }
      return fs.read(p);
    },
    async exists(p) {
      if ((await catalogName(p)) !== undefined) return true;
      if (sameFolder(p, globalFolder()) && (await safeNames()).length > 0) return true;
      return fs.exists(p);
    },
    async list(d) {
      const inner = await fs.list(d);
      if (!sameFolder(d, globalFolder())) return inner;
      const extra = (await safeNames()).filter((n) => !inner.includes(n));
      return extra.length ? [...inner, ...extra] : inner;
    },
    async write(p, c) {
      await guard(p);
      return fs.write(p, c);
    },
    async modify(p, u) {
      await guard(p);
      return fs.modify(p, u);
    },
    async remove(p) {
      await guard(p);
      return fs.remove(p);
    },
    async rename(a, b) {
      await guard(a, b);
      return fs.rename(a, b);
    },
    async trash(p) {
      await guard(p);
      return fs.trash(p);
    },
    mkdir: (p) => fs.mkdir(p),
    rmdir: (p) => fs.rmdir(p),
  };
}
