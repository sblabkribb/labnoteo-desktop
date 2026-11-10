/**
 * 스킨 갤러리(assistant 명세 §8.5, plan Task 19): 목록 보기, 미리 보기, 확인 후 설치, "갤러리에 올리기".
 *
 * - 목록 주소는 Rust 가 이 PC 의 `assistant.json`(`galleryUrl`, 비면 기본 주소)에서 읽는다. 웹뷰는 주소를 보내지 않는다.
 * - 내려받기는 항목 id 만 보낸다. Rust 가 마지막으로 읽은 목록에서 찾아 받고, 크기·SHA-256 을 목록과 맞춰 본 뒤 팩 검사를 한다.
 *   스킨 파일의 라이선스가 목록과 다르면 Rust 가 임시 보관하지 않는다(`stagingId` 없음): 설치 단추가 꺼지고 까닭을 보인다.
 * - 갤러리에서 온 글(이름, 만든 사람, 설명 …)은 남이 쓴 글이다. 글자로만 보이고(React 가 이스케이프), 제어·방향 문자는 지운다.
 *   어떤 모델에게도 보내지 않는다: 이 파일과 대화상자는 어시스턴트 런타임이나 AI 모듈을 가져오지 않는다.
 * - 설치는 언제나 미리 보기 → "설치" → 이름·만든 사람·라이선스를 적은 확인을 거친다. 저절로 설치하거나 뒤에서 새로 읽지 않는다.
 * - "갤러리에 올리기"는 설치한 스킨 id 만 보낸다. Rust 가 그 스킨의 manifest 로 GitHub 새 이슈 주소를 만들어 브라우저로 연다(토큰 없음).
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../../integrations/netIpc';
import { t } from '../../i18n/t';
import { openDialog } from '../../labnote/host/dialogStore';
import { notify as toast } from '../../labnote/host/toastStore';
import { readAssistantConfig } from '../config';
import { BUILTIN_SKIN_ID } from './builtin';
import { skinErrorText, toSkinError, type SkinData } from './store';
import { confirmAndInstall } from './transfer';
import type { SkinManifest } from './types';
import type { SkinUrls } from './useSkin';

/** `galleryUrl` 이 비었을 때 Rust 가 쓰는 목록 주소(`skins/gallery.rs` 의 DEFAULT_INDEX_URL). 화면에 보여 주기만 한다. */
export const DEFAULT_GALLERY_URL = 'https://raw.githubusercontent.com/ParkYaeseong/labnoteo-assistant-skins/main/index.json';

/** 목록의 한 스킨(Rust 가 정리한 글). 팩 주소는 Rust 에만 있다. */
export interface GalleryEntry {
  id: string;
  name: string;
  author: string;
  licence: string;
  version: string;
  description?: string;
  size: number;
  sha256: string;
}

export interface GalleryList {
  url: string;
  skins: GalleryEntry[];
}

/** 내려받아 검사한 팩. 라이선스가 목록과 다르면 `stagingId` 가 null 이라 설치할 수 없다. */
export interface GalleryPreview extends SkinData {
  stagingId: string | null;
  indexLicence: string;
  licenceMatches: boolean;
}

async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toSkinError(e);
  }
}

/** 갤러리 목록을 읽는다(주소는 Rust 가 설정에서 읽는다). */
export function fetchGalleryIndex(invoke: InvokeFn = tauriInvoke): Promise<GalleryList> {
  return call<GalleryList>(invoke, 'skin_gallery_index', {});
}

/** 목록의 항목 하나를 내려받아 검사하고 미리 보기를 받는다. 설치하지 않는다. */
export function fetchGallerySkin(entryId: string, invoke: InvokeFn = tauriInvoke): Promise<GalleryPreview> {
  return call<GalleryPreview>(invoke, 'skin_gallery_fetch', { entryId });
}

/** 설치한 스킨 `id` 의 "갤러리에 올리기" 페이지를 브라우저로 연다. */
export async function openSubmitPage(id: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'skin_submit_open', { id });
}

const HIDDEN = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜]/g;

/** 갤러리 글에서 제어 문자와 방향 바꾸기 문자를 지운다(Rust 도 지우지만 한 번 더). */
export function cleanGalleryText(s: string): string {
  return s.replace(HIDDEN, '').trim();
}

/** 파일 크기를 짧게(KB, MB). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 대화상자가 쓰는 것(테스트는 가짜를 넣는다). */
export interface GalleryDialogDeps {
  invoke?: InvokeFn;
  urls?: SkinUrls;
  /** 목록을 못 읽었을 때 보여 줄 주소(기본: 설정의 갤러리 주소, 비면 기본 주소). */
  galleryUrl?: () => Promise<string>;
}

/** 설정의 갤러리 주소(비면 기본 주소). 보여 주기만 한다. */
export async function configuredGalleryUrl(invoke: InvokeFn = tauriInvoke): Promise<string> {
  return (await readAssistantConfig(invoke)).galleryUrl ?? DEFAULT_GALLERY_URL;
}

export interface GalleryDeps extends GalleryDialogDeps {
  notify?: (kind: 'info' | 'warn', message: string) => void;
  setSkin?: (id: string) => void;
}

/** 갤러리 창. 고른 미리 보기(설치하겠다는 뜻), 닫으면 undefined. */
export function skinGalleryDialog(deps: GalleryDialogDeps): Promise<GalleryPreview | undefined> {
  return openDialog<GalleryPreview | undefined>({ kind: 'skinGallery', deps }, undefined);
}

/** 갤러리를 열어 고르고, 확인을 받아 설치한다. 설치한 스킨의 manifest, 그만두면 undefined. */
export async function browseGallery(deps: GalleryDeps = {}): Promise<SkinManifest | undefined> {
  const invoke = deps.invoke ?? tauriInvoke;
  const picked = await skinGalleryDialog({
    invoke,
    urls: deps.urls,
    galleryUrl: deps.galleryUrl ?? (() => configuredGalleryUrl(invoke)),
  });
  if (!picked || !picked.stagingId || !picked.licenceMatches) return undefined;
  return confirmAndInstall({ stagingId: picked.stagingId, manifest: picked.manifest }, { ...deps, invoke });
}

export interface SubmitDeps {
  invoke?: InvokeFn;
  notify?: (kind: 'info' | 'warn', message: string) => void;
}

/** "갤러리에 올리기": 설치한 스킨만 된다(기본 스킨은 안내만). 페이지를 열었으면 true. */
export async function submitToGallery(id: string, deps: SubmitDeps = {}): Promise<boolean> {
  const notify = deps.notify ?? toast;
  if (id === BUILTIN_SKIN_ID) {
    notify('info', t('skin.submit.builtin'));
    return false;
  }
  try {
    await openSubmitPage(id, deps.invoke ?? tauriInvoke);
    notify('info', t('skin.submit.opened'));
    return true;
  } catch (e) {
    notify('warn', t('skin.submit.failed', skinErrorText(e)));
    return false;
  }
}
