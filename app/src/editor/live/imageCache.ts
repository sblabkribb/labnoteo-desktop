import { MIME, extOf } from './imagePath';

/**
 * 보관함 이미지의 blob: URL 캐시(계획 Task 21). 바이트는 `read`(vault_read_image)로 한 번만 읽고 Blob URL 로 만든다.
 * - 참조 수를 센다: 위젯이 `url` 로 얻고 `release` 로 놓는다. 참조 중인 URL 은 쫓아내지 않는다.
 * - 최근에 쓴 순서(LRU)로 `CAPACITY` 개까지 둔다. 넘치면 가장 오래된 참조 없는 것부터 쫓아내며 URL 을 거둔다(revoke).
 * - `invalidate`(파일이 바뀌었다)와 `clear`(보관함을 바꿨다)도 URL 을 거둔다. 아직 읽는 중인 항목은 다 읽은 뒤 바로 거둔다.
 * - 읽기에 실패한 경로는 남기지 않는다: 다음에 다시 읽어 본다.
 */
export interface ImageCache {
  url(path: string): Promise<string>;
  release(path: string): void;
  invalidate(path: string): void;
  clear(): void;
}

export const CAPACITY = 64;

interface Entry {
  promise: Promise<string>;
  url?: string;
  refs: number;
  /** 캐시에서 빠졌다: 읽기가 끝나면 만든 URL 을 바로 거둔다. */
  dead: boolean;
}

const defaultUrls = {
  create: (b: Blob) => URL.createObjectURL(b),
  revoke: (u: string) => URL.revokeObjectURL(u),
};

export function createImageCache(
  read: (path: string) => Promise<ArrayBuffer>,
  urls: { create(b: Blob): string; revoke(u: string): void } = defaultUrls,
): ImageCache {
  const entries = new Map<string, Entry>();
  /** 캐시에서 빠질 때 아직 참조 중이던 수: 그 참조의 release 가 새로 읽은 항목의 수를 깎지 않게 먼저 여기서 깎는다. */
  const ghosts = new Map<string, number>();

  const drop = (path: string, e: Entry) => {
    entries.delete(path);
    if (e.refs > 0) ghosts.set(path, (ghosts.get(path) ?? 0) + e.refs);
    e.dead = true;
    if (e.url !== undefined) urls.revoke(e.url);
    e.url = undefined;
  };

  const evict = () => {
    if (entries.size <= CAPACITY) return;
    for (const [path, e] of entries) {
      if (entries.size <= CAPACITY) break;
      if (e.refs === 0) drop(path, e);
    }
  };

  return {
    url(path) {
      const old = entries.get(path);
      if (old) {
        old.refs++;
        // 최근에 쓴 것을 맨 뒤로
        entries.delete(path);
        entries.set(path, old);
        return old.promise;
      }
      const e: Entry = { refs: 1, dead: false, promise: undefined as unknown as Promise<string> };
      e.promise = read(path).then(
        (buf) => {
          const u = urls.create(new Blob([buf], { type: MIME[extOf(path)] ?? 'application/octet-stream' }));
          if (e.dead) urls.revoke(u);
          else e.url = u;
          return u;
        },
        (err: unknown) => {
          if (entries.get(path) === e) entries.delete(path);
          e.dead = true;
          throw err;
        },
      );
      entries.set(path, e);
      evict();
      return e.promise;
    },
    release(path) {
      const ghost = ghosts.get(path);
      if (ghost) {
        if (ghost > 1) ghosts.set(path, ghost - 1);
        else ghosts.delete(path);
        return;
      }
      const e = entries.get(path);
      if (!e) return;
      e.refs = Math.max(0, e.refs - 1);
      evict();
    },
    invalidate(path) {
      const e = entries.get(path);
      if (e) drop(path, e);
    },
    clear() {
      for (const [path, e] of [...entries]) drop(path, e);
    },
  };
}
