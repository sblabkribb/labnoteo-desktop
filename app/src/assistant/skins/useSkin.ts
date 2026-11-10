import { useEffect, useState } from 'react';
import type { InvokeFn } from '../../integrations/netIpc';
import { BUILTIN_SKIN, BUILTIN_SKIN_ID, builtinSheetUrl } from './builtin';
import { readSkin } from './store';
import { SKIN_STATES, type SkinManifest, type SkinState } from './types';

/**
 * 지금 쓰는 스킨(assistant 명세 §8.3, R6).
 * - 기본 스킨은 앱 안의 그림('self')을 쓴다. IPC 도 blob 도 쓰지 않는다.
 * - 설치한 스킨은 Rust 가 다시 검사해 준 PNG 바이트로 `blob:` 주소를 만든다(CSP img-src blob:). `asset:` 은 쓰지 않는다.
 *   스킨을 바꾸거나 화면에서 빠지면 그 주소를 모두 거둔다(revoke).
 * - 모르는 id, 읽기 실패(없음·바뀐 파일·디스크 오류)는 기본 스킨으로 돌아간다.
 */
export interface ActiveSkin {
  id: string;
  manifest: SkinManifest;
  sheetUrl(state: SkinState): string;
  /** 만든 blob 주소를 거둔다(기본 스킨은 할 일이 없다). 두 번 불러도 된다. */
  dispose(): void;
}

export interface SkinUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

export interface SkinDeps {
  invoke?: InvokeFn;
  urls?: SkinUrls;
}

const browserUrls: SkinUrls = {
  create: (b) => URL.createObjectURL(b),
  revoke: (u) => URL.revokeObjectURL(u),
};

export const BUILTIN_ACTIVE: ActiveSkin = Object.freeze({
  id: BUILTIN_SKIN_ID,
  manifest: BUILTIN_SKIN,
  sheetUrl: builtinSheetUrl,
  dispose: () => undefined,
});

export async function loadSkin(id: string, deps: SkinDeps = {}): Promise<ActiveSkin> {
  if (id === BUILTIN_SKIN_ID) return BUILTIN_ACTIVE;
  const urls = deps.urls ?? browserUrls;
  let data;
  try {
    data = await readSkin(id, deps.invoke);
  } catch (e) {
    console.warn('[labnoteo] skin read failed; using the built-in skin:', e);
    return BUILTIN_ACTIVE;
  }
  if (!data || data.manifest?.id !== id || !data.sheets) return BUILTIN_ACTIVE;
  const made: Partial<Record<SkinState, string>> = {};
  const dispose = () => {
    for (const st of SKIN_STATES) {
      const u = made[st];
      if (u) urls.revoke(u);
      delete made[st];
    }
  };
  for (const st of SKIN_STATES) {
    const bytes = data.sheets[st];
    if (!bytes) {
      dispose();
      return BUILTIN_ACTIVE;
    }
    made[st] = urls.create(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
  }
  const manifest = data.manifest;
  return { id, manifest, sheetUrl: (st) => made[st] ?? '', dispose };
}

/** 스킨 id 를 따라 스킨을 읽는다. 읽는 동안과 실패하면 기본 스킨이다. */
export function useSkin(id: string, deps: SkinDeps = {}): ActiveSkin {
  const [skin, setSkin] = useState<ActiveSkin>(BUILTIN_ACTIVE);
  const { invoke, urls } = deps;
  useEffect(() => {
    let live = true;
    let loaded: ActiveSkin | undefined;
    // 바꾸는 동안은 기본 스킨(앞 스킨의 blob 주소는 아래 정리에서 거둔다)
    setSkin(BUILTIN_ACTIVE);
    if (id !== BUILTIN_SKIN_ID)
      void loadSkin(id, { invoke, urls }).then((s) => {
        if (!live) {
          s.dispose();
          return;
        }
        loaded = s;
        setSkin(s);
      });
    return () => {
      live = false;
      loaded?.dispose();
    };
  }, [id, invoke, urls]);
  return skin;
}
