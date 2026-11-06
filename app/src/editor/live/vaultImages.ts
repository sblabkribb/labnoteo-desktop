import { listVaultImages, readVaultImage } from '../../fs/vaultImage';
import { createImageCache, type ImageCache } from './imageCache';
import { isImageTarget, pickByName } from './imagePath';

/**
 * 보관함 이미지 이름 색인(계획 Task 21). 이름만 쓴 임베드(`![[x.png]]`)를 찾으려고 보관함의 이미지 경로 목록을
 * (`vault_list_images`) 한 번 읽어 둔다. 바뀌면 `invalidate` 로 버리고 다음에 다시 읽는다. 읽기에 실패하면 빈 목록이고
 * 남기지 않는다(다음에 다시 읽어 본다).
 *
 * 보관함 감시(watcher.rs)는 노트(.md)와 폴더, 지워진 경로만 알린다: 새로 넣은 이미지 파일은 알림이 없다. 그래서 이름을
 * 찾지 못했고 목록이 `MISS_RELIST_MS` 보다 오래됐으면 한 번 다시 읽어 본다(노트를 다시 열면 새 이미지가 보인다).
 */
export interface ImageIndex {
  find(notePath: string, name: string): Promise<string | null>;
  isUnique(name: string): Promise<boolean>;
  invalidate(): void;
}

/** 이름을 찾지 못했을 때 목록을 다시 읽기 전에 그 목록이 묵어야 하는 시간. 찾지 못한 임베드가 많아도 이 사이 한 번만 읽는다. */
export const MISS_RELIST_MS = 2000;

export function createImageIndex(list: () => Promise<string[]>, now: () => number = () => Date.now()): ImageIndex {
  let paths: Promise<string[]> | null = null;
  let loadedAt = 0;
  const load = (): Promise<string[]> => {
    if (paths) return paths;
    loadedAt = now();
    const p: Promise<string[]> = list().catch(() => {
      if (paths === p) paths = null;
      return [];
    });
    paths = p;
    return p;
  };
  return {
    async find(notePath, name) {
      const used = load();
      const found = pickByName(notePath, name, await used);
      if (found !== null || now() - loadedAt < MISS_RELIST_MS) return found;
      // 묵은 목록에서 못 찾았다: 아직 아무도 새로 읽지 않았으면 한 번 다시 읽는다.
      if (paths === used) paths = null;
      return pickByName(notePath, name, await load());
    },
    async isUnique(name) {
      const want = name.toLowerCase();
      return (await load()).filter((p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase() === want).length === 1;
    },
    invalidate() {
      paths = null;
    },
  };
}

/**
 * 편집기가 쓰는 이미지 묶음: blob: URL 캐시, 이름 색인, 바뀜 알림. `subscribe` 가 있으면 위젯은 바뀔 때마다 다시 찾는다
 * (캐시에 남은 것은 다시 읽지 않는다).
 */
export interface VaultImages {
  cache: ImageCache;
  index: ImageIndex;
  onChanged(paths: string[]): void;
  clear(): void;
  subscribe?(listener: () => void): () => void;
}

export function createVaultImages(
  cache: ImageCache = createImageCache((path) => readVaultImage(path)),
  index: ImageIndex = createImageIndex(() => listVaultImages()),
): VaultImages {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const clear = () => {
    cache.clear();
    index.invalidate();
    notify();
  };
  return {
    cache,
    index,
    /**
     * 보관함 감시가 알린 한 묶음의 경로들(계획 D6). 빈 경로('')는 "무엇이 바뀌었는지 놓쳤다": 모두 버린다.
     * 그 밖에는 묶음마다 이름 색인을 버리고(새 폴더·노트와 함께 이미지가 들어왔을 수 있다) 위젯들에 알린다.
     * 캐시된 바이트는 이미지 경로만 버린다. 감시는 이미지 파일의 생성·수정을 알리지 않고 지움만 알린다:
     * 덮어쓴 이미지는 보관함을 다시 열거나 앱을 다시 시작할 때까지 예전 그림이다(알려진 한계).
     */
    onChanged(paths) {
      if (paths.includes('')) return clear();
      for (const p of paths) if (isImageTarget(p)) cache.invalidate(p);
      index.invalidate();
      notify();
    },
    clear,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** 앱의 보관함 이미지(앱의 invoke 로 vault_read_image / vault_list_images 를 부른다). 보관함을 바꾸면 App 이 clear 한다. */
export const vaultImages: VaultImages = createVaultImages();
