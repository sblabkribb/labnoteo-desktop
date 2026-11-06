import { listVaultImages, readVaultImage } from '../../fs/vaultImage';
import { createImageCache, type ImageCache } from './imageCache';
import { isImageTarget, pickByName } from './imagePath';

/**
 * 보관함 이미지 이름 색인(계획 Task 21). 이름만 쓴 임베드(`![[x.png]]`)를 찾으려고 보관함의 이미지 경로 목록을
 * (`vault_list_images`) 한 번 읽어 둔다. 바뀌면 `invalidate` 로 버리고 다음에 다시 읽는다. 읽기에 실패하면 빈 목록이고
 * 남기지 않는다(다음에 다시 읽어 본다).
 */
export interface ImageIndex {
  find(notePath: string, name: string): Promise<string | null>;
  isUnique(name: string): Promise<boolean>;
  invalidate(): void;
}

export function createImageIndex(list: () => Promise<string[]>): ImageIndex {
  let paths: Promise<string[]> | null = null;
  const load = (): Promise<string[]> => {
    if (paths) return paths;
    const p: Promise<string[]> = list().catch(() => {
      if (paths === p) paths = null;
      return [];
    });
    paths = p;
    return p;
  };
  return {
    async find(notePath, name) {
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

function createVaultImages(): VaultImages {
  const cache = createImageCache((path) => readVaultImage(path));
  const index = createImageIndex(() => listVaultImages());
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
    /** 보관함 감시가 알린 경로들. 빈 경로('')는 "무엇이 바뀌었는지 놓쳤다": 모두 버린다. 이미지가 아닌 경로는 무시한다. */
    onChanged(paths) {
      if (paths.includes('')) return clear();
      const images = paths.filter((p) => isImageTarget(p));
      if (!images.length) return;
      for (const p of images) cache.invalidate(p);
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
