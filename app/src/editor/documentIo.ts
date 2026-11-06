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
  /** 줄바꿈 방식. 섞인 파일(`mixed`)에서는 더 많은 쪽이다. */
  eol: 'lf' | 'crlf';
  /**
   * CRLF 줄과 LF 줄이 섞여 있다. 이 경우 `text` 는 원문 그대로(CR 을 지우지 않음)이고 저장도 그대로 되돌려 쓴다 —
   * 한 줄을 고쳤는데 파일 전체의 줄바꿈이 바뀌어 git 에서 모든 줄이 바뀐 것으로 보이는 일이 없다.
   */
  mixed: boolean;
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

/** 디스크 원문에서 BOM 과 줄바꿈 방식을 감지해 에디터용 본문을 만든다. */
export function parseRaw(path: string, raw: string): LoadedDocument {
  const hadBom = raw.startsWith(BOM);
  const body = hadBom ? raw.slice(BOM.length) : raw;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf; // CRLF 의 일부가 아닌 단독 LF
  // 단독 CR(CRLF 의 일부가 아닌 CR)이 있어도 섞인 것이다: CR CR LF 를 LF 로 정규화하면 앞의 CR 이 사라진다.
  const mixed = (crlf > 0 && lf > 0) || /\r(?!\n)/.test(body);
  const eol = crlf > 0 && crlf >= lf ? 'crlf' : 'lf';
  // 섞이지 않은 CRLF 파일만 LF 본문으로 정규화한다(저장 때 되돌린다). 섞인 파일은 손대지 않는다.
  return { path, text: mixed ? body : body.replace(/\r\n/g, '\n'), eol, mixed, hadBom, loadedText: raw };
}

export async function loadDocument(path: string, invoke: InvokeFn = tauriInvoke): Promise<LoadedDocument> {
  return parseRaw(path, await invoke<string>('vault_read', { path }));
}

/** 에디터 본문을 읽었을 때의 인코딩(BOM, 줄바꿈)으로 되돌린 디스크 원문. BOM 이나 CRLF 를 새로 만들지 않는다. */
export function toRaw(doc: Pick<LoadedDocument, 'eol' | 'hadBom' | 'mixed'>, text: string): string {
  if (doc.mixed) return doc.hadBom ? BOM + text : text; // 본문에 줄 끝이 이미 있는 그대로 들어 있다
  const lf = text.replace(/\r\n/g, '\n');
  const body = doc.eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
  return doc.hadBom ? BOM + body : body;
}

/** 에디터가 줄을 나누는 구분자. 섞인 파일은 본문에 CR 이 남아 있으므로 더 많은 쪽 구분자를 쓴다. */
export function lineSeparatorOf(doc: Pick<LoadedDocument, 'eol' | 'mixed'>): '\n' | '\r\n' {
  return doc.mixed && doc.eol === 'crlf' ? '\r\n' : '\n';
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
