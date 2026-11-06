import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { t } from '../../i18n/t';
import { basenameKey, linkKey, splitLinktext } from '../../links/resolve';
import { subpathLine } from '../../links/subpath';
import { isImageTarget } from './imagePath';
import { linkResolution } from './linkResolution';
import { revealInline } from './reveal';
// @labnoteo/core 가 내보내지 않는 기호라 상대 경로로 가져온다(편집 금지인 vendor 를 읽기만 한다).
import { UNIT_OP_HEADING_PATTERN } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/workflowSectionParser';

/**
 * 라이브 미리보기의 링크(계획 D12): Markdown 링크, `[[위키링크]]`, 유닛 오퍼레이션 제목의 코드 칩.
 * - 그리기는 inline.ts 가 이 파일의 판정 함수(isRealLink, unitOpHeading)로 한다.
 * - 누름(SP4 D4): 렌더된 링크는 그냥 클릭으로, 어느 모드든 Ctrl(맥은 Cmd)+클릭으로, 커서 아래 링크는 Alt+Enter 로 연다
 *   (`linkClickHandler`, `followLinkAtCursor`). 대상은 `targetOf` 가 링크 색인의 풀이(linkResolution facet)로 정한다.
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
/** 코드 뒤 이름과 닫는 대괄호: 위 두 패턴의 꼬리와 같다. */
const NAME_TAIL = /\s+(.+?)\]/y;

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
  // 닫는 `]` 는 두 패턴이 같은 꼬리(NAME_TAIL)를 코드 바로 뒤에서 다시 맞춰 찾는다. 이름이 공백뿐이면
  // (`[UHW010  ]`, IME 의 전각 공백) 이름 길이로 셈하면 `]` 를 지나 줄 끝에 닿는다.
  NAME_TAIL.lastIndex = codeTo;
  const tail = NAME_TAIL.exec(lineText);
  if (!tail) return null;
  const close = codeTo + tail[0].length - 1;
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

/** A link found in the syntax tree around a position (`linkAt`). Images are never links here. */
export type LinkHit =
  | { kind: 'wiki'; from: number; to: number; linkpath: string; subpath: string; embed: boolean }
  | { kind: 'md'; from: number; to: number; href: string };

/** What opening a link does (D5-D7). `subpath` / `anchor` are set only when non-empty. */
export type OpenTarget =
  | { kind: 'note'; path: string; anchor?: string; subpath?: string }
  | { kind: 'create'; linkpath: string }
  | { kind: 'external'; url: string };

/** A plain click opens only when the button comes up within this many pixels of where it went down (D4). */
export const CLICK_SLOP_PX = 4;

/** URL nodes under these parents are a link target, an image path or a reference definition, not a bare URL. */
const NOT_BARE_URL = new Set(['Link', 'Image', 'LinkReference', 'Autolink']);

/** The hit for node `n`; null stops the search (not a link), undefined goes on to the parent. */
function hitFromNode(state: EditorState, n: SyntaxNode): LinkHit | null | undefined {
  switch (n.name) {
    case 'Image':
      return null;
    case 'WikiLink':
    case 'Embed': {
      const target = n.getChild('WikiTarget');
      if (!target) return null;
      const text = state.sliceDoc(target.from, target.to);
      const embed = n.name === 'Embed';
      if (embed && isImageTarget(text)) return null;
      const { path, subpath } = splitLinktext(text);
      return { kind: 'wiki', from: n.from, to: n.to, linkpath: path, subpath, embed };
    }
    case 'Link': {
      if (!isRealLink(n)) return undefined;
      const href = linkHref(state, n);
      return href === null ? null : { kind: 'md', from: n.from, to: n.to, href };
    }
    case 'Autolink': {
      const url = n.getChild('URL');
      return url ? { kind: 'md', from: n.from, to: n.to, href: state.sliceDoc(url.from, url.to) } : null;
    }
    case 'URL':
      // The Link, Image or Autolink above answers for its own URL
      if (n.parent && NOT_BARE_URL.has(n.parent.name)) return undefined;
      return { kind: 'md', from: n.from, to: n.to, href: state.sliceDoc(n.from, n.to) };
    default:
      return undefined;
  }
}

function hitAround(state: EditorState, pos: number, side: -1 | 1): LinkHit | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
    const hit = hitFromNode(state, n);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * The link around `pos`: a wikilink, a note embed, a real Markdown link (its URL or reference definition),
 * an `<https://…>` autolink or a bare URL. Images and image embeds are not links. Null when there is none.
 */
export function linkAt(state: EditorState, pos: number): LinkHit | null {
  return hitAround(state, pos, 1) ?? hitAround(state, pos, -1);
}

/**
 * Where a link goes from note `notePath` (D2, D5). `self` is a place in this note (`line` undefined when the
 * heading is missing). Null when there is nothing to open: an attachment the app does not list, a malformed
 * path, or an unresolved wikilink before the link index is ready.
 */
export function targetOf(
  state: EditorState,
  hit: LinkHit,
  notePath: string,
): OpenTarget | { kind: 'self'; line: number | undefined } | null {
  const res = state.facet(linkResolution);
  const doc = () => state.doc.toString();
  if (hit.kind === 'wiki') {
    const { linkpath, subpath } = hit;
    if (linkpath === '') return { kind: 'self', line: subpathLine(doc(), { subpath }) };
    const found = res?.resolveWiki(linkpath, notePath) ?? null;
    if (found !== null) return subpath ? { kind: 'note', path: found, subpath } : { kind: 'note', path: found };
    // A self link before this note is in the file list (a note just created): stay here
    if (notePath !== '' && !linkpath.includes('/') && linkKey(linkpath) === basenameKey(notePath))
      return { kind: 'self', line: subpath ? subpathLine(doc(), { subpath }) : 0 };
    if (!res || res.isUnknownTarget(linkpath)) return null;
    return { kind: 'create', linkpath };
  }
  let h = hit.href.trim();
  if (h.startsWith('<') && h.endsWith('>')) h = h.slice(1, -1).trim();
  if (h === '') return null;
  if (h.startsWith('#')) return { kind: 'self', line: subpathLine(doc(), { anchor: h.slice(1) }) };
  if (SCHEME.test(h)) return { kind: 'external', url: h };
  const hash = h.indexOf('#');
  const anchor = hash < 0 ? '' : h.slice(hash + 1);
  if (!res) {
    // No link index yet: read the relative path as before (whether the note exists is not checked)
    const legacy = resolveNoteLink(notePath, h);
    if (legacy?.kind !== 'note') return null;
    return legacy.anchor ? { kind: 'note', path: legacy.path, anchor: legacy.anchor } : { kind: 'note', path: legacy.path };
  }
  const found = res.resolveMd(h, notePath);
  if (found !== null) return anchor ? { kind: 'note', path: found, anchor } : { kind: 'note', path: found };
  let decoded: string;
  try {
    decoded = decodeURIComponent(hash < 0 ? h : h.slice(0, hash)).normalize('NFC');
  } catch {
    return null;
  }
  if (decoded === '' || res.isUnknownTarget(decoded)) return null;
  let linkpath = decoded.replace(/^(\.\/)+/, '');
  if (linkpath === '') return null;
  // A Markdown path is relative to this note: keep a folder path relative (D6 reads `a/b` as vault-rooted)
  if (linkpath.includes('/') && !linkpath.startsWith('/') && !linkpath.startsWith('../')) linkpath = `./${linkpath}`;
  return { kind: 'create', linkpath };
}

export interface LinkOpenDeps {
  /** The vault path of this note. */
  notePath(): string;
  /** Opens another note, creates a missing one or opens an external address (App wires it). */
  onOpen(target: OpenTarget): void;
  /** Moves the caret to that line (0-based) of this note and shows it. */
  reveal(line: number): void;
  /** Shows one notice. */
  toast(message: string): void;
}

function follow(view: EditorView, hit: LinkHit, deps: LinkOpenDeps): void {
  const target = targetOf(view.state, hit, deps.notePath());
  if (!target) return;
  if (target.kind === 'self') {
    if (target.line !== undefined) deps.reveal(target.line);
    else deps.toast(t('live.link.anchorMissing'));
    return;
  }
  deps.onOpen(target);
}

/** The rendered link or wikilink element nearest the event target. */
function linkElement(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const hit = el?.closest<HTMLElement>('.lno-link, .lno-wikilink') ?? null;
  return hit && root.contains(hit) ? hit : null;
}

function safePosAtDOM(view: EditorView, node: Node): number | null {
  try {
    return view.posAtDOM(node, 0);
  } catch {
    return null;
  }
}

/** The document position under a mouse event: the rendered link element first, then the coordinates. */
function eventPos(view: EditorView, e: MouseEvent, el: HTMLElement | null): number | null {
  if (el) return safePosAtDOM(view, el);
  let at: number | null = null;
  try {
    at = view.posAtCoords({ x: e.clientX, y: e.clientY });
  } catch {
    at = null;
  }
  if (at !== null) return at;
  return e.target instanceof Node && view.contentDOM.contains(e.target) ? safePosAtDOM(view, e.target) : null;
}

const plainButton = (e: MouseEvent) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;

/**
 * Link clicks (D4).
 * - Ctrl/Cmd+click opens the link under the pointer in both modes, rendered or revealed. CodeMirror would add a
 *   cursor, so the mousedown is prevented and consumed.
 * - A plain left click on a rendered link (live preview, `revealInline` false) opens it: the mousedown is
 *   prevented (the caret stays) and recorded, and the following click opens it when the pointer moved at most
 *   `CLICK_SLOP_PX`. A drag opens nothing. A revealed link takes a plain click as a caret placement.
 * - While an IME composition runs, a plain click does nothing.
 */
export function linkClickHandler(deps: LinkOpenDeps): Extension {
  let pending: { view: EditorView; from: number; x: number; y: number } | null = null;
  return EditorView.domEventHandlers({
    mousedown: (e, view) => {
      pending = null;
      if (e.button !== 0) return false;
      const el = linkElement(e.target, view.contentDOM);
      if (e.ctrlKey || e.metaKey) {
        const pos = eventPos(view, e, el);
        const hit = pos === null ? null : linkAt(view.state, pos);
        if (!hit) return false;
        e.preventDefault();
        follow(view, hit, deps);
        return true;
      }
      if (!plainButton(e) || !el || view.composing) return false;
      const pos = safePosAtDOM(view, el);
      const hit = pos === null ? null : linkAt(view.state, pos);
      if (!hit || revealInline(view.state, hit.from, hit.to)) return false;
      e.preventDefault();
      pending = { view, from: hit.from, x: e.clientX, y: e.clientY };
      return true;
    },
    click: (e, view) => {
      const p = pending;
      pending = null;
      if (!p || p.view !== view || !plainButton(e) || view.composing) return false;
      if (Math.abs(e.clientX - p.x) > CLICK_SLOP_PX || Math.abs(e.clientY - p.y) > CLICK_SLOP_PX) return false;
      const el = linkElement(e.target, view.contentDOM);
      const pos = el ? safePosAtDOM(view, el) : null;
      const hit = pos === null ? null : linkAt(view.state, pos);
      if (!hit || hit.from !== p.from) return false;
      e.preventDefault();
      follow(view, hit, deps);
      return true;
    },
  });
}

/** Alt+Enter: follows the link under the cursor (Obsidian's "Follow link under cursor"). False when there is none. */
export function followLinkAtCursor(deps: LinkOpenDeps): (view: EditorView) => boolean {
  return (view) => {
    if (view.composing) return false;
    const hit = linkAt(view.state, view.state.selection.main.head);
    if (!hit) return false;
    follow(view, hit, deps);
    return true;
  };
}

