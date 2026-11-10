/**
 * 출처 장부(assistant spec §4.5). 한 번의 실행에서 도구가 내준 출처마다 [n] 번호를 붙인다.
 * - 노트는 보관함 안 상대 경로, 웹·논문은 http/https 주소만 받는다(`javascript:`, `data:`, `file:`, 계정이 든 주소는 거절 = 0).
 * - 이름표는 제어·양방향 글자를 빼고 줄인다. 화면은 글로만 그린다(HTML 아님).
 * - `render` 는 답의 `[n]` 중 장부에 있는 번호만 인용 조각으로 바꾸고, 나머지는 글 그대로 둔다(마크다운을 읽지 않는다).
 */

export type SourceKind = 'note' | 'web' | 'paper';

export interface Source {
  kind: SourceKind;
  /** 사람에게 보이는 짧은 이름(파일 이름, 페이지 제목, 논문 제목). */
  label: string;
  /** 노트: 보관함 상대 경로. 웹·논문: http/https 주소. */
  target: string;
}

export type RenderedPart = string | { n: number; src: Source };

/** 이름표 최대 길이(글자). Rust 기록 저장소의 한도(4 KiB)보다 작다. */
export const SOURCE_LABEL_MAX = 300;
/** 한 실행의 출처 수 한도. 넘으면 더 받지 않는다(0). */
export const SOURCE_MAX = 100;

// Controls (C0, DEL, C1) and bidi/zero-width formatting characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

function cleanLabel(label: string, fallback: string): string {
  const text = label.replace(/[\r\n\t]+/g, ' ').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, SOURCE_LABEL_MAX);
}

/** http/https 주소를 파싱한 그대로(`href`). 다른 스킴, 계정 정보, 파싱 실패는 undefined. */
function webTarget(target: string): string | undefined {
  let u: URL;
  try {
    u = new URL(target.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password || !u.hostname) return undefined;
  return u.href;
}

/** 보관함 상대 경로(`/` 구분). 드라이브·스킴(`:`), 절대 경로, UNC, `..`, 제어 글자는 undefined. */
function noteTarget(target: string): string | undefined {
  const p = target.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (!p || /[\u0000-\u001f\u007f:]/.test(p) || p.startsWith('/')) return undefined;
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0 || parts.some((s) => s === '..')) return undefined;
  return parts.join('/').normalize('NFC');
}

/** 받을 수 있는 대상이면 정리한 값, 아니면 undefined. */
export function safeTarget(kind: SourceKind, target: string): string | undefined {
  if (typeof target !== 'string') return undefined;
  return kind === 'note' ? noteTarget(target) : webTarget(target);
}

export class SourceLedger {
  private readonly entries: Source[] = [];

  /** 저장해 둔 목록에서 다시 만든다(거절되는 것은 빠진다). */
  static from(sources: readonly Source[]): SourceLedger {
    const l = new SourceLedger();
    for (const s of sources) l.add(s);
    return l;
  }

  /** 출처를 넣고 번호(1부터)를 준다. 같은 종류·대상은 같은 번호. 받을 수 없으면 0. */
  add(src: Source): number {
    if (src.kind !== 'note' && src.kind !== 'web' && src.kind !== 'paper') return 0;
    const target = safeTarget(src.kind, src.target);
    if (!target) return 0;
    const i = this.entries.findIndex((e) => e.kind === src.kind && e.target === target);
    if (i >= 0) return i + 1;
    if (this.entries.length >= SOURCE_MAX) return 0;
    this.entries.push({ kind: src.kind, label: cleanLabel(String(src.label ?? ''), target), target });
    return this.entries.length;
  }

  get(n: number): Source | undefined {
    return Number.isInteger(n) && n >= 1 ? this.entries[n - 1] : undefined;
  }

  list(): Source[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** `[n]` 을 장부에 있는 번호만 인용 조각으로. 이웃한 글 조각은 하나로 합친다. */
  render(text: string): RenderedPart[] {
    const out: RenderedPart[] = [];
    const push = (s: string) => {
      if (!s) return;
      const last = out[out.length - 1];
      if (typeof last === 'string') out[out.length - 1] = last + s;
      else out.push(s);
    };
    const re = /\[(\d{1,3})\]/g;
    let at = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const n = Number(m[1]);
      const src = this.get(n);
      if (!src) continue;
      push(text.slice(at, m.index));
      out.push({ n, src });
      at = m.index + m[0].length;
    }
    push(text.slice(at));
    return out;
  }
}
