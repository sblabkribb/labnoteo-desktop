import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { resolveGithubAnchor } from '@labnoteo/core';
import { t } from '../../i18n/t';
// @labnoteo/core 가 내보내지 않는 기호라 상대 경로로 가져온다(편집 금지인 vendor 를 읽기만 한다).
import { UNIT_OP_HEADING_PATTERN } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/workflowSectionParser';

/**
 * 라이브 미리보기의 링크(계획 D12): Markdown 링크, `[[위키링크]]`, 유닛 오퍼레이션 제목의 코드 칩.
 * - 그리기는 inline.ts 가 이 파일의 판정 함수(isRealLink, unitOpHeading)로 한다.
 * - Ctrl(맥은 Cmd)+클릭은 `linkClickHandler` 가 mousedown 에서 받는다. CodeMirror 에서 Ctrl+클릭은 커서 더하기라
 *   preventDefault 하고 true 를 돌려 선택이 늘지 않게 한다.
 * - 위키링크는 모양만 낸다: 이동은 SP4 다. 바깥 주소 열기도 SP4 라 지금은 알림만 띄운다.
 */

export type NoteLink = { kind: 'note'; path: string; anchor?: string } | { kind: 'anchor'; anchor: string } | { kind: 'external' };

/** 두 글자 이상의 URI 스킴(`https:`, `mailto:`). 한 글자(`C:`)는 Windows 드라이브다. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/**
 * 노트 `notePath`(보관함 기준 POSIX 경로) 안의 링크 주소 `href` 가 가리키는 곳.
 * - `#제목`: 이 노트 안의 앵커.
 * - 스킴이 있으면 바깥 주소.
 * - 그 밖에는 노트 기준 상대 경로(`/` 로 시작하면 보관함 기준)의 `.md` 노트. `%XX` 는 풀어서 읽는다.
 * 보관함 밖으로 나가거나(`..` 가 넘침), 드라이브·역슬래시·콜론이 든 경로, `.md` 가 아닌 파일이면 null.
 */
export function resolveNoteLink(notePath: string, href: string): NoteLink | null {
  let h = href.trim();
  if (h.startsWith('<') && h.endsWith('>')) h = h.slice(1, -1).trim();
  if (!h) return null;
  if (h.startsWith('#')) return h.length > 1 ? { kind: 'anchor', anchor: h.slice(1) } : null;
  if (SCHEME.test(h)) return { kind: 'external' };
  const hash = h.indexOf('#');
  const rawPath = hash < 0 ? h : h.slice(0, hash);
  const anchor = hash < 0 ? '' : h.slice(hash + 1);
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath.split('?')[0]);
  } catch {
    return null;
  }
  if (!rel || rel.includes('\\') || rel.includes(':') || /[\u0000-\u001f]/.test(rel)) return null;
  const parts = rel.startsWith('/') ? [] : notePath.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  if (parts.length === 0) return null;
  const path = parts.join('/');
  if (!/\.md$/i.test(path)) return null;
  return anchor ? { kind: 'note', path, anchor } : { kind: 'note', path };
}

/** 워크플로 제목 `## [WB010 이름] 별칭`. 유닛 오퍼레이션(`### [UHW010 …]`)은 코어의 UNIT_OP_HEADING_PATTERN 이다. */
const WORKFLOW_HEADING = /^##\s+\[([A-Z]+\d+)\s+(.+?)\]/;

export type UnitOpKind = 'UHW' | 'USW' | 'WB' | 'other';

/**
 * 줄 글자(`\r` 이 끝에 붙어 있어도 된다)가 유닛 오퍼레이션·워크플로 제목이면 코드의 위치(줄 안의 오프셋)와 종류,
 * 그리고 감쌀 대괄호의 위치(`open`, `close`). 아니면 null.
 */
export function unitOpHeading(
  lineText: string,
): { codeFrom: number; codeTo: number; kind: UnitOpKind; open: number; close: number } | null {
  const m = UNIT_OP_HEADING_PATTERN.exec(lineText) ?? WORKFLOW_HEADING.exec(lineText);
  if (!m) return null;
  const open = lineText.indexOf('[');
  const codeFrom = open + 1;
  const codeTo = codeFrom + m[1].length;
  let nameFrom = codeTo;
  while (/\s/.test(lineText[nameFrom])) nameFrom++;
  const close = nameFrom + m[2].length;
  const prefix = /^[A-Z]+/.exec(m[1])![0];
  const kind: UnitOpKind = prefix === 'UHW' || prefix === 'USW' || prefix === 'WB' ? prefix : 'other';
  return { codeFrom, codeTo, kind, open, close };
}

/**
 * Lezer 의 `Link` 가 진짜 링크인가: URL 자식이 있거나 `[글][참조]`·`[글][]` 처럼 LinkLabel 이 있다.
 * Lezer 는 대괄호로 싼 글자를 모두 Link 로 읽으므로, 이 검사가 없으면 `see [1] here` 가 가짜 링크가 된다.
 */
export function isRealLink(node: SyntaxNode): boolean {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'URL' || c.name === 'LinkLabel') return true;
  return false;
}

/** 링크 참조 이름의 비교 형태(CommonMark: 대소문자 무시, 공백 묶음). */
const refKey = (label: string) => label.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

function stripAngles(url: string): string {
  return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url;
}

/** Link 노드의 주소: URL 자식, 아니면 같은 문서의 `[참조]: 주소` 정의. 찾지 못하면 null. */
export function linkHref(state: EditorState, link: SyntaxNode): string | null {
  let label: string | null = null;
  let firstClose = -1;
  for (let c = link.firstChild; c; c = c.nextSibling) {
    if (c.name === 'URL') return stripAngles(state.sliceDoc(c.from, c.to));
    if (c.name === 'LinkMark' && firstClose < 0 && c.from > link.from) firstClose = c.from;
    if (c.name === 'LinkLabel') label = state.sliceDoc(c.from, c.to);
  }
  if (label === null) return null;
  // `[글][]` 는 글 자체가 참조 이름이다
  const key = refKey(label) || refKey(state.sliceDoc(link.from + 1, firstClose < 0 ? link.from + 1 : firstClose));
  if (!key) return null;
  let found: string | null = null;
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (found !== null) return false;
      if (ref.name !== 'LinkReference') return;
      const n = ref.node;
      const l = n.getChild('LinkLabel');
      const u = n.getChild('URL');
      if (l && u && refKey(state.sliceDoc(l.from, l.to)) === key) found = stripAngles(state.sliceDoc(u.from, u.to));
      return false;
    },
  });
  return found;
}

export interface LinkOpenDeps {
  /** 지금 노트의 보관함 기준 경로. */
  notePath(): string;
  /** 다른 노트를 연다(App 이 잇는다). */
  onOpenLink?(target: { path: string; anchor?: string }): void;
  /** 알림 하나를 띄운다. */
  toast(message: string): void;
  /** 이 노트의 그 줄(0부터)로 커서를 옮겨 보인다. */
  reveal(line: number): void;
}

/** 눌린 요소에서 가장 가까운 렌더된 링크·위키링크. */
function linkElement(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const hit = el?.closest<HTMLElement>('.lno-link, .lno-wikilink') ?? null;
  return hit && root.contains(hit) ? hit : null;
}

/** 위치 `pos` 를 감싼 가장 안쪽의 `name` 노드. */
function enclosing(state: EditorState, pos: number, name: string): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (n.name === name) return n;
  return null;
}

/** 렌더된 링크의 Ctrl/Cmd+클릭(왼쪽 단추). 위키링크는 받기만 하고 아무 데로도 가지 않는다(SP4). */
export function linkClickHandler(deps: LinkOpenDeps): Extension {
  return EditorView.domEventHandlers({
    mousedown: (e, view) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false;
      const el = linkElement(e.target, view.contentDOM);
      if (!el) return false;
      e.preventDefault();
      if (el.classList.contains('lno-wikilink')) return true;
      const { state } = view;
      const link = enclosing(state, view.posAtDOM(el, 0), 'Link');
      const href = link ? linkHref(state, link) : null;
      const target = href === null ? null : resolveNoteLink(deps.notePath(), href);
      if (!target) return true;
      if (target.kind === 'external') deps.toast(t('live.link.externalLater'));
      else if (target.kind === 'note') deps.onOpenLink?.(target.anchor ? { path: target.path, anchor: target.anchor } : { path: target.path });
      else {
        const line = resolveGithubAnchor(state.doc.toString(), target.anchor);
        if (line !== undefined) deps.reveal(line);
      }
      return true;
    },
  });
}
