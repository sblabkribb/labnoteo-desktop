/**
 * 실험실 도구 결과 다듬기(design §0.4, §3): 서버 객체를 그대로 보내지 않고 짧은 줄로 만든다. 글은 자르고, 줄 수와 결과
 * 전체 글자 수(12 000자)를 넘으면 뒤에서부터 줄을 뺀다. 이 파일은 네트워크를 쓰지 않는다.
 */

/** 도구 결과 하나의 최대 글자 수(울타리 전). */
export const RESULT_MAX_CHARS = 12_000;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/** 목록 답: 배열이거나 `{items}`·`{results}` 꼴. */
export function listOf(v: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(v)) return records(v);
  if (!isRecord(v)) return [];
  for (const k of [...keys, 'items', 'results']) if (Array.isArray(v[k])) return records(v[k]);
  return [];
}

/** 글자 값(앞뒤 빈칸 정리). 글이 아니거나 비면 undefined. 수는 글로 바꾼다. */
export function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

/** 첫 번째로 있는 글자 값. */
export function firstStr(o: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const s = str(o[k]);
    if (s !== undefined) return s;
  }
  return undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Controls (C0 except tab/newline, DEL, C1) and bidi/zero-width formatting characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** 한 줄로(줄바꿈은 빈칸), 위험한 글자 없이, `max` 글자까지(넘으면 끝에 `…`). */
export function clip(v: unknown, max: number): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const line = s.replace(/[\r\n\t]+/g, ' ').replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line;
}

/** 여러 줄 글(마크다운)을 줄바꿈은 두고 `max` 글자까지. 잘렸는지도 돌려준다. */
export function clipBlock(v: unknown, max: number): { text: string; clipped: boolean } {
  const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(UNSAFE, '') : '';
  const chars = [...s];
  return chars.length > max ? { text: chars.slice(0, max).join(''), clipped: true } : { text: s, clipped: false };
}

/** 글 목록이나 객체 목록(이름 칸)을 `"; "` 로 이은 한 줄. */
export function joinList(v: unknown, max: number): string | undefined {
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => (isRecord(x) ? firstStr(x, 'name', 'label', 'title', 'id') : str(x)))
      .filter((x): x is string => !!x);
    return clip(parts.join('; '), max);
  }
  if (isRecord(v)) {
    return clip(
      Object.entries(v)
        .map(([k, x]) => (str(x) !== undefined ? `${k}: ${str(x)}` : ''))
        .filter(Boolean)
        .join('; '),
      max,
    );
  }
  return clip(v, max);
}

/** undefined 칸을 뺀 객체(JSON 이 짧아진다). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** 결과의 JSON 글. */
export function jsonText(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * `result[key]` 의 줄을 뒤에서부터 빼서 결과 JSON 이 `max` 글자 안에 들게 한다. 뺀 줄이 있으면 `more` 를 정한다(이미 있던
 * `more` 보다 뺀 줄 수를 앞에 둔다). 줄을 다 빼도 넘으면 그대로 둔다(`finalText` 가 자른다).
 */
export function fitRows<T extends Record<string, unknown>>(result: T, key: keyof T & string, max = RESULT_MAX_CHARS): T {
  const rows = Array.isArray(result[key]) ? [...(result[key] as unknown[])] : [];
  let out = result;
  let dropped = 0;
  while (jsonText(out).length > max && rows.length > 0) {
    rows.pop();
    dropped++;
    out = { ...result, [key]: rows, more: `${dropped} row(s) left out to keep the answer short; ask for fewer or narrow the query` };
  }
  return out;
}

/** 마지막 안전장치: JSON 글이 `max` 를 넘으면 자르고 잘렸다고 적는다. */
export function finalText(v: unknown, max = RESULT_MAX_CHARS): string {
  const text = jsonText(v);
  return text.length > max ? `${text.slice(0, max)}\n[clipped: the result was longer than ${max} characters]` : text;
}
