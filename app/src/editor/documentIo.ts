import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const BOM = '\uFEFF';

/**
 * 읽은 노트. `text` 는 에디터에 주는 본문(BOM 없음, 줄바꿈은 LF)이고
 * `loadedText` 는 디스크에서 읽은 원문 그대로다 — 저장할 때 "읽은 뒤로 안 바뀌었나"의 기준이 된다.
 */
export interface LoadedDocument {
  path: string;
  text: string;
  eol: 'lf' | 'crlf';
  hadBom: boolean;
  loadedText: string;
}

export type SaveResult = { ok: true } | { ok: false; reason: 'conflict'; current: string };

export interface SaveOptions {
  /** 사용자가 덮어쓰기를 골랐다. */
  force?: boolean;
  /**
   * force 와 함께: 사용자가 대화상자에서 본 디스크 내용(conflict 가 돌려준 `current`).
   * 이것을 기대값으로 보내므로, 대화상자를 읽는 사이 세 번째 변경이 생겼다면 덮어쓰지 않고
   * 다시 conflict 가 된다. 생략하면 기대값 없이 무조건 덮어쓴다.
   */
  against?: string;
  invoke?: InvokeFn;
}

type ModifyResult = { kind: 'ok' } | { kind: 'conflict'; current: string };

/**
 * 줄바꿈 방식. 모든 `\n` 이 `\r\n` 의 일부일 때만 CRLF 가 아니라, CRLF 줄이 LF 만 있는 줄보다
 * 많으면 CRLF 로 본다. 섞여 있는 파일은 저장하면 한쪽으로 통일된다(드문 경우).
 */
function detectEol(raw: string): 'lf' | 'crlf' {
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  return crlf > 0 && crlf >= lf ? 'crlf' : 'lf';
}

/** 디스크 원문에서 BOM 과 줄바꿈 방식을 감지해 에디터용 본문을 만든다. */
export function parseRaw(path: string, raw: string): LoadedDocument {
  const hadBom = raw.startsWith(BOM);
  const body = hadBom ? raw.slice(BOM.length) : raw;
  const eol = detectEol(body);
  return { path, text: body.replace(/\r\n/g, '\n'), eol, hadBom, loadedText: raw };
}

export async function loadDocument(path: string, invoke: InvokeFn = tauriInvoke): Promise<LoadedDocument> {
  return parseRaw(path, await invoke<string>('vault_read', { path }));
}

/** 에디터 본문을 읽었을 때의 인코딩(BOM, 줄바꿈)으로 되돌린 디스크 원문. BOM 이나 CRLF 를 새로 만들지 않는다. */
export function toRaw(doc: Pick<LoadedDocument, 'eol' | 'hadBom'>, text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  const body = doc.eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
  return doc.hadBom ? BOM + body : body;
}

/**
 * 저장. Rust 가 경로 잠금 안에서 "디스크 == 읽었던 원문" 을 확인하고 쓴다. 다르면 쓰지 않고
 * 디스크의 현재 내용을 돌려준다. 성공 뒤 호출자는 `loadedText` 를 `toRaw(doc, text)` 로 갱신한다.
 */
export async function saveDocument(doc: LoadedDocument, text: string, opts: SaveOptions = {}): Promise<SaveResult> {
  const invoke = opts.invoke ?? tauriInvoke;
  const args: Record<string, unknown> = { path: doc.path, content: toRaw(doc, text) };
  const expected = opts.force ? opts.against : doc.loadedText;
  if (expected !== undefined) args.expectedBefore = expected;
  const r = await invoke<ModifyResult>('vault_modify', args);
  return r.kind === 'ok' ? { ok: true } : { ok: false, reason: 'conflict', current: r.current };
}
