/**
 * 내 스킨 만들기(editor-lite)의 초안(assistant 명세 §8.4, plan Task 18).
 *
 * - 웹뷰는 PNG 바이트나 경로를 보내지 않는다. Rust 의 열기 창(`skin_pick_sheet`)이 PNG 를 읽고 검사해 다시 만든 뒤
 *   임시 보관하고 무작위 토큰과 크기, 미리 보기용 바이트를 돌려준다. 초안(`SkinDraft`)에는 글, 한 칸 크기, 상태별 토큰·칸 수·속도만 있다.
 * - `skin_build(draft)` 는 Rust 가 토큰의 PNG 와 초안으로 만든 manifest 를 묶어 `validate_pack` 에 넣고, 가져오기처럼 임시 보관한다.
 *   설치(`skin_install`)와 내보내기(`skin_export_staged`)는 그 보관 id 만 쓴다.
 * - 여기의 검사는 바로 보여 주는 안내용이다. 판단은 Rust 가 다시 한다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../../integrations/netIpc';
import { t } from '../../i18n/t';
import { toSkinError, type StagedSkin } from './store';
import { SKIN_LICENCES, SKIN_STATES, type SkinLicence, type SkinState } from './types';

/** Rust `skins/pack.rs` 와 같은 한도(명세 §8.1–8.2). */
export const FRAME_MIN = 16;
export const FRAME_MAX = 96;
export const FRAMES_MAX = 16;
export const FPS_MAX = 24;
export const NAME_MAX = 40;
export const AUTHOR_MAX = 60;
export const DESCRIPTION_MAX = 200;

/** `skin_pick_sheet` 의 답: Rust 가 다시 만든 PNG 의 토큰, 크기, 바이트(미리 보기 blob 용). */
export interface PickedSheet {
  sheetToken: string;
  width: number;
  height: number;
  bytes: number[] | Uint8Array;
}

export interface DraftStateSpec {
  sheetToken: string;
  frames: number;
  fps: number;
}

/** Rust 로 보내는 초안. 바이트도 경로도 없다. */
export interface SkinDraft {
  name: string;
  author: string;
  licence: string;
  description?: string;
  frame: { width: number; height: number };
  states: Record<SkinState, DraftStateSpec>;
}

export interface EditorStateSpec {
  sheet?: PickedSheet;
  frames: number;
  fps: number;
}

/** 편집 창의 값. 숫자 칸은 비우면 NaN 이 될 수 있다(그러면 안내가 뜬다). */
export interface SkinEditorState {
  name: string;
  author: string;
  licence: SkinLicence | '';
  description: string;
  frame: { width: number; height: number };
  states: Record<SkinState, EditorStateSpec>;
}

export type DraftField =
  | 'name'
  | 'author'
  | 'licence'
  | 'description'
  | 'frame'
  | `${SkinState}.sheet`
  | `${SkinState}.frames`
  | `${SkinState}.fps`;
export type DraftErrors = Partial<Record<DraftField, string>>;

export function emptyEditorState(): SkinEditorState {
  const st = (): EditorStateSpec => ({ frames: 4, fps: 6 });
  return {
    name: '',
    author: '',
    licence: '',
    description: '',
    frame: { width: 32, height: 32 },
    states: { idle: st(), talk: st(), think: st(), done: st() },
  };
}

const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** 고친 곳(칸 → 짧은 안내). 비어 있으면 Rust 로 보낼 수 있다. */
export function draftErrors(s: SkinEditorState): DraftErrors {
  const e: DraftErrors = {};
  const name = s.name.trim();
  if (!name) e.name = t('skin.editor.error.name');
  else if ([...name].length > NAME_MAX) e.name = t('skin.editor.error.tooLong', NAME_MAX);
  const author = s.author.trim();
  if (!author) e.author = t('skin.editor.error.author');
  else if ([...author].length > AUTHOR_MAX) e.author = t('skin.editor.error.tooLong', AUTHOR_MAX);
  if (!s.licence) e.licence = t('skin.licenceNeeded');
  else if (!(SKIN_LICENCES as readonly string[]).includes(s.licence)) e.licence = t('skin.error.licenceNotAllowed');
  if ([...s.description.trim()].length > DESCRIPTION_MAX) e.description = t('skin.editor.error.tooLong', DESCRIPTION_MAX);
  const frameOk = intIn(s.frame.width, FRAME_MIN, FRAME_MAX) && intIn(s.frame.height, FRAME_MIN, FRAME_MAX);
  if (!frameOk) e.frame = t('skin.editor.error.frame', FRAME_MIN, FRAME_MAX);
  for (const st of SKIN_STATES) {
    const spec = s.states[st];
    const framesOk = intIn(spec.frames, 1, FRAMES_MAX);
    if (!framesOk) e[`${st}.frames`] = t('skin.editor.error.frames', FRAMES_MAX);
    if (!intIn(spec.fps, 1, FPS_MAX)) e[`${st}.fps`] = t('skin.editor.error.fps', FPS_MAX);
    if (!spec.sheet) e[`${st}.sheet`] = t('skin.editor.error.sheet');
    else if (frameOk && framesOk) {
      const w = s.frame.width * spec.frames;
      const h = s.frame.height;
      if (spec.sheet.width !== w || spec.sheet.height !== h)
        e[`${st}.sheet`] = t('skin.editor.error.sheetSize', spec.sheet.width, spec.sheet.height, w, h);
    }
  }
  return e;
}

/** 보낼 초안. 고칠 곳이 있으면 null. */
export function toDraft(s: SkinEditorState): SkinDraft | null {
  if (Object.keys(draftErrors(s)).length > 0) return null;
  const states = {} as Record<SkinState, DraftStateSpec>;
  for (const st of SKIN_STATES) {
    const { sheet, frames, fps } = s.states[st];
    states[st] = { sheetToken: sheet!.sheetToken, frames, fps };
  }
  const draft: SkinDraft = {
    name: s.name.trim(),
    author: s.author.trim(),
    licence: s.licence,
    frame: { width: s.frame.width, height: s.frame.height },
    states,
  };
  const description = s.description.trim();
  if (description) draft.description = description;
  return draft;
}

/**
 * 상태 `state` 에 고른 그림을 넣는다. 처음 고른 그림의 높이가 한도 안이고 지금 한 칸 높이와 다르면 그 높이의 정사각형으로 한 칸을 맞춘다.
 * 그림 너비가 한 칸 너비로 나누어떨어지면(1–16칸) 칸 수를 채운다.
 */
export function withSheet(s: SkinEditorState, state: SkinState, sheet: PickedSheet): SkinEditorState {
  let frame = s.frame;
  const first = SKIN_STATES.every((st) => st === state || !s.states[st].sheet);
  if (first && sheet.height !== frame.height && intIn(sheet.height, FRAME_MIN, FRAME_MAX)) frame = { width: sheet.height, height: sheet.height };
  const guess = frame.width > 0 ? sheet.width / frame.width : NaN;
  const frames = intIn(guess, 1, FRAMES_MAX) ? guess : s.states[state].frames;
  return { ...s, frame, states: { ...s.states, [state]: { ...s.states[state], sheet, frames } } };
}

async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toSkinError(e);
  }
}

/** Rust 의 열기 창으로 PNG 하나를 고른다(1 MiB 넘으면 읽기 전에 거절). 닫으면 null. */
export function pickSheet(invoke: InvokeFn = tauriInvoke): Promise<PickedSheet | null> {
  return call<PickedSheet | null>(invoke, 'skin_pick_sheet', {});
}

/** 초안으로 팩을 만들어 Rust 가 검사(validate_pack)하고 임시 보관한다. 설치하지 않는다. */
export function buildSkin(draft: SkinDraft, invoke: InvokeFn = tauriInvoke): Promise<StagedSkin> {
  return call<StagedSkin>(invoke, 'skin_build', { draft });
}

/** 임시 보관한 팩을 Rust 의 저장 창으로 쓴다. 저장했으면 true, 닫았으면 false. */
export function exportStagedSkin(stagingId: string, invoke: InvokeFn = tauriInvoke): Promise<boolean> {
  return call<boolean>(invoke, 'skin_export_staged', { stagingId });
}
