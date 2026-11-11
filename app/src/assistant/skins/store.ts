/**
 * 설치한 스킨의 IPC 클라이언트(assistant 명세 §8.3, plan Task 16). 저장소는 Rust(`src-tauri/src/skins/store.rs`)에 있고
 * 이 PC 의 앱 데이터 폴더(`assistant/skins/<id>-<sha8>/`)에만 쓴다. 보관함에는 쓰지 않는다.
 *
 * - 웹뷰는 스킨 id 와, Rust 가 만든 임시 보관 id(stagingId)와 바꾸기 여부만 보낸다. 팩 바이트나 경로는 보내지 않는다.
 * - 기본 스킨(Flasko)은 앱에 들어 있다(`public/skins/flasko`, 'self'). Rust 목록에는 없고, 지울 수 없다.
 * - 쓰고 있는 스킨을 지우면 기본 스킨으로 돌아간다(이 PC 의 ui.json `pet.skin`).
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../../integrations/netIpc';
import { t } from '../../i18n/t';
import { layoutStore } from '../../ui/layoutStore';
import { BUILTIN_SKIN, BUILTIN_SKIN_ID } from './builtin';
import type { SkinManifest, SkinState } from './types';

/** Rust `SkinErrorKind` (`src-tauri/tests/ipc-skin-errors.json`). */
export const SKIN_ERROR_KINDS = [
  'tooLarge',
  'tooManyEntries',
  'badArchive',
  'badPath',
  'fileNotAllowed',
  'symlink',
  'encrypted',
  'unsupportedMethod',
  'duplicate',
  'sizeMismatch',
  'compressionRatio',
  'manifestMissing',
  'manifestInvalid',
  'licenceMissing',
  'licenceNotAllowed',
  'stateMissing',
  'sheetMissing',
  'sheetUnused',
  'badPng',
  'pngTooLarge',
  'sheetSize',
  'animatedPng',
  'stagingUnknown',
  'exists',
  'builtin',
  'notFound',
  'tampered',
  'galleryUnreachable',
  'galleryInvalid',
  'galleryMismatch',
  'io',
] as const;
export type SkinErrorKind = (typeof SKIN_ERROR_KINDS)[number];

export class SkinStoreError extends Error {
  constructor(
    readonly kind: SkinErrorKind,
    /** 파일·칸 이름(Rust 가 정리한 글). 화면에는 글자로만 보인다. */
    readonly detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'SkinStoreError';
  }
}

/** Rust 의 거절 `{kind, detail?}` 를 `SkinStoreError` 로. 모르는 것은 `io`. */
export function toSkinError(e: unknown): SkinStoreError {
  if (e instanceof SkinStoreError) return e;
  if (e && typeof e === 'object') {
    const o = e as { kind?: unknown; detail?: unknown };
    const kind = (SKIN_ERROR_KINDS as readonly unknown[]).includes(o.kind) ? (o.kind as SkinErrorKind) : 'io';
    return new SkinStoreError(kind, typeof o.detail === 'string' ? o.detail : undefined);
  }
  return new SkinStoreError('io', String(e));
}

/** `skin_read` 의 답: 시트 이름은 `<state>.png`, 바이트는 숫자 배열(IPC 에 base64 는 쓰지 않는다). */
export interface SkinData {
  manifest: SkinManifest;
  sheets: Record<SkinState, number[] | Uint8Array>;
}

async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toSkinError(e);
  }
}

/** 설치한 스킨(기본 스킨은 빠진다). */
export function listSkins(invoke: InvokeFn = tauriInvoke): Promise<SkinManifest[]> {
  return call<SkinManifest[]>(invoke, 'skin_list', {});
}

/** 설치한 스킨 하나. Rust 가 읽을 때마다 다시 검사한다(디스크에서 바뀐 파일은 `tampered`). */
export function readSkin(id: string, invoke: InvokeFn = tauriInvoke): Promise<SkinData> {
  return call<SkinData>(invoke, 'skin_read', { id });
}

/**
 * 스킨 id 마다 설치한 파일이 바뀐 횟수. 쓰고 있는 스킨을 같은 id 로 바꿔 설치하면 `pet.skin` 은 그대로라 useSkin 이 이 값으로
 * 다시 읽는다. 다른 id 를 설치해도 그 id 의 값만 바뀐다: 떠 있는 도우미처럼 늘 그려진 useSkin 이 괜히 다시 읽지 않는다.
 */
const skinRevisions = new Map<string, number>();
const revisionSubs = new Set<() => void>();
export function getSkinRevision(id: string): number {
  return skinRevisions.get(id) ?? 0;
}
export function subscribeSkinRevision(fn: () => void): () => void {
  revisionSubs.add(fn);
  return () => void revisionSubs.delete(fn);
}
function bumpSkinRevision(id: string): void {
  skinRevisions.set(id, getSkinRevision(id) + 1);
  for (const fn of [...revisionSubs]) fn();
}

/** 임시 보관한 팩을 설치한다. 같은 id 의 다른 스킨이 있으면 `replace` 없이는 `exists`. */
export async function installSkin(stagingId: string, replace: boolean, invoke: InvokeFn = tauriInvoke): Promise<SkinManifest> {
  const m = await call<SkinManifest>(invoke, 'skin_install', { stagingId, replace });
  // Rust always returns the manifest; a test double may not
  if (m?.id) bumpSkinRevision(m.id);
  return m;
}

export async function removeSkin(id: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'skin_remove', { id });
}

export interface RemoveDeps {
  invoke?: InvokeFn;
  activeSkin?: () => string;
  setSkin?: (id: string) => void;
}

/** 스킨을 지운다. 쓰고 있던 스킨이면 기본 스킨으로 바꾼다. 기본 스킨은 지우지 않는다(`builtin`). */
export async function removeSkinAndFallBack(id: string, deps: RemoveDeps = {}): Promise<void> {
  if (id === BUILTIN_SKIN_ID) throw new SkinStoreError('builtin', id);
  const activeSkin = deps.activeSkin ?? (() => layoutStore.get().pet.skin);
  const setSkin = deps.setSkin ?? ((skin: string) => layoutStore.setPet({ skin }));
  await removeSkin(id, deps.invoke);
  if (activeSkin() === id) setSkin(BUILTIN_SKIN_ID);
}

export interface SkinChoice {
  id: string;
  name: string;
  author: string;
  licence: string;
  builtin: boolean;
}

/** 고르기 목록: 기본 스킨이 맨 앞, 그다음 설치한 스킨(기본 id 를 쓰는 항목은 뺀다). */
export function skinChoices(installed: readonly SkinManifest[]): SkinChoice[] {
  const pick = (m: SkinManifest, builtin: boolean): SkinChoice => ({ id: m.id, name: m.name, author: m.author, licence: m.licence, builtin });
  return [pick(BUILTIN_SKIN, true), ...installed.filter((m) => m.id !== BUILTIN_SKIN_ID).map((m) => pick(m, false))];
}

// ------------------------------------------------------------ 가져오기·내보내기(plan Task 17)

/** Rust 가 읽고 검사해 임시 보관한 팩: 보관 id, manifest(시트 이름은 `<state>.png`), 상태별 다시 만든 PNG 바이트. */
export interface StagedSkin extends SkinData {
  stagingId: string;
}

/**
 * Rust 의 열기 창으로 `.labnoteo-skin` 파일을 고르게 한다. 경로는 웹뷰가 보내지 않는다. 2 MiB 가 넘는 파일은 읽기 전에 거절한다.
 * 검사를 통과하면 임시 보관만 한다(설치하지 않는다). 닫으면 null.
 */
export function pickSkinFile(invoke: InvokeFn = tauriInvoke): Promise<StagedSkin | null> {
  return call<StagedSkin | null>(invoke, 'skin_import_pick', {});
}

/** 가져오기를 그만둘 때 임시 보관한 팩을 버린다. */
export async function discardStagedSkin(stagingId: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<boolean>(invoke, 'skin_staging_discard', { stagingId });
}

/** 스킨(설치한 것 또는 기본 스킨)을 Rust 의 저장 창으로 팩 파일로 쓴다. 저장했으면 true, 닫았으면 false. */
export function exportSkin(id: string, invoke: InvokeFn = tauriInvoke): Promise<boolean> {
  return call<boolean>(invoke, 'skin_export', { id });
}

/** 스킨 거절을 짧은 안내로(ko·en). 파일 이름은 Rust 가 정리한 글이고 글자로만 보인다. */
export function skinErrorText(e: unknown): string {
  const err = toSkinError(e);
  const detail = err.detail ?? '';
  switch (err.kind) {
    case 'tooLarge':
    case 'tooManyEntries':
    case 'compressionRatio':
      return t('skin.error.tooLarge');
    case 'badPath':
    case 'symlink':
      // zip-slip(../, 절대 경로)과 링크: 위험한 것을 찾았다고 말한다(Visual QA)
      return t('skin.error.unsafePath');
    case 'badArchive':
    case 'encrypted':
    case 'unsupportedMethod':
    case 'duplicate':
    case 'sizeMismatch':
      return t('skin.error.archive');
    case 'fileNotAllowed':
      return t('skin.error.fileNotAllowed', detail);
    case 'manifestMissing':
    case 'manifestInvalid':
    case 'stateMissing':
    case 'sheetMissing':
    case 'sheetUnused':
      return t('skin.error.manifest');
    case 'licenceMissing':
      return t('skin.licenceNeeded');
    case 'licenceNotAllowed':
      return t('skin.error.licenceNotAllowed');
    case 'badPng':
    case 'pngTooLarge':
    case 'sheetSize':
    case 'animatedPng':
      return t('skin.error.image');
    case 'stagingUnknown':
      return t('skin.error.staging');
    case 'exists':
      return t('skin.error.exists');
    case 'builtin':
      return t('skin.error.builtin');
    case 'notFound':
      return t('skin.error.notFound');
    case 'tampered':
      return t('skin.error.tampered');
    case 'galleryUnreachable':
      return t('gallery.unreachable');
    case 'galleryInvalid':
      return t('skin.error.galleryInvalid');
    case 'galleryMismatch':
      return t('skin.error.galleryMismatch');
    case 'io':
      return t('skin.error.io');
  }
}
