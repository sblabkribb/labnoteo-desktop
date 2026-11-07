/**
 * `[[` completion: notes, aliases, labnote titles and (after `![[`) images (plan SP4 Task 15, decision D9), and
 * after `[[note#` that note's headings, after `[[#` this note's headings (Task 16).
 *
 * The source is never gated on composition: CodeMirror keeps the composing syllable in the document, so the
 * list ranks on it and stays open while a Korean syllable composes. Only acceptance is gated: `apply` returns
 * without dispatching while `view.composing`, and `wikiCompletionGuards()` keeps Enter and Tab away from the
 * completion keymap while the IME owns them, then reopens the list after `compositionend`.
 */
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import type { PickItem } from '@labnoteo/core';
import { rankPickItems } from '../labnote/port/rankPickItems';
import { outerOf } from '../editor/table/cellEditor';
import { extractOutline, type OutlineItem } from '../editor/outline/extract';
import { sanitizeHeading } from './subpath';
import { IMAGE_EXTS, wikiBasename, type Resolver } from './resolve';

export const COMPLETION_MAX = 50;

export interface WikiCompletionDeps {
  notePath(): string;
  snapshot(): {
    files: readonly string[];
    aliases: readonly { path: string; alias: string }[];
    titles: ReadonlyMap<string, string>; // .labnote.md path -> front-matter title
    resolver: Resolver;
  } | null;
  headings(path: string): Promise<OutlineItem[]>; // Task 16
}

export interface WikiContext {
  embed: boolean;
  query: string;
  heading?: { linkpath: string; query: string };
}

/** The open `[[`/`![[` before the cursor on this line, or null when the cursor is not inside one. */
export function wikiContext(lineBefore: string): WikiContext | null {
  const at = lineBefore.lastIndexOf('[[');
  if (at < 0) return null;
  const rest = lineBefore.slice(at + 2);
  // A closed link, an alias, or a bracket: not a link path being typed.
  if (/[\]|[]/.test(rest)) return null;
  const embed = at > 0 && lineBefore[at - 1] === '!';
  const hash = rest.indexOf('#');
  if (hash >= 0) return { embed, query: '', heading: { linkpath: rest.slice(0, hash), query: rest.slice(hash + 1) } };
  return { embed, query: rest };
}

const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'CodeMark']);

/** True when `pos` is inside code: a code node in the syntax tree, or an unclosed backtick run earlier on the line. */
function inCode(state: EditorState, pos: number, lineBefore: string): boolean {
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
  for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true;
  }
  // An unclosed code span is not a node yet, but the text after it is code once the user closes it.
  let open = 0;
  for (const m of lineBefore.matchAll(/`+/g)) {
    const len = m[0].length;
    if (open === 0) open = len;
    else if (open === len) open = 0;
  }
  return open !== 0;
}

/** A Table ancestor in the syntax tree at `pos`, or `view` is a table cell editor. */
export function inTable(state: EditorState, pos: number, view?: EditorView): boolean {
  if (view && outerOf(view)) return true;
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
  for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'Table') return true;
  }
  return false;
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function extOf(path: string): string {
  const seg = path.slice(path.lastIndexOf('/') + 1);
  const i = seg.lastIndexOf('.');
  return i < 0 ? '' : seg.slice(i + 1).toLowerCase();
}

interface Row {
  linktext: string;
  /** Written after `|`: the alias, or a labnote title. */
  alias?: string;
}

/** Replaces the typed link path with `<linktext>[|alias]]]`, absorbing a `]]` already after the cursor. */
function applyRow(row: Row): Completion['apply'] {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    if (view.composing) return; // D9: never accept mid-composition
    const { state } = view;
    const end = to + (state.doc.sliceString(to, to + 2) === ']]' ? 2 : 0);
    const sep = inTable(state, from, view) ? '\\|' : '|';
    const insert = `${row.linktext}${row.alias !== undefined ? `${sep}${row.alias}` : ''}]]`;
    view.dispatch({
      changes: { from, to: end, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
  };
}

/** Replaces the typed heading query (after `#`) with `<sanitised heading>]]`, absorbing a `]]` after the cursor. */
function applyHeading(text: string): Completion['apply'] {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    if (view.composing) return; // D9: never accept mid-composition
    const end = to + (view.state.doc.sliceString(to, to + 2) === ']]' ? 2 : 0);
    const insert = `${text}]]`;
    view.dispatch({
      changes: { from, to: end, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
  };
}

/**
 * The heading rows after `[[<linkpath>#` (Task 16). An empty linkpath, or one that resolves to the open note, lists
 * this document's headings from the buffer (`noteState`; the outer editor's state when completing in a table cell);
 * another note's come from `deps.headings`. Unresolved: null.
 * The inserted text is `sanitizeHeading` of the heading (D9), which `subpathLine` resolves back to it.
 */
async function headingCompletions(
  deps: WikiCompletionDeps,
  noteState: EditorState,
  pos: number,
  heading: { linkpath: string; query: string },
): Promise<CompletionResult | null> {
  const source = deps.notePath();
  let items: OutlineItem[];
  if (heading.linkpath.trim() === '') {
    items = extractOutline(noteState.doc.toString());
  } else {
    const snap = deps.snapshot();
    if (!snap) return null;
    const target = snap.resolver.resolveWiki(heading.linkpath, source);
    if (target === null || !/\.md$/i.test(target)) return null;
    items = target === source ? extractOutline(noteState.doc.toString()) : await deps.headings(target);
  }
  const rows: PickItem<string>[] = [];
  for (const item of items) {
    const text = sanitizeHeading(item.text);
    if (text !== '') rows.push({ label: item.text, value: text });
  }
  const ranked = rankPickItems(rows, heading.query).slice(0, COMPLETION_MAX);
  return {
    from: pos - heading.query.length,
    filter: false,
    options: ranked.map((row) => ({ label: row.label, apply: applyHeading(row.value) })),
  };
}

export function wikiCompletionSource(deps: WikiCompletionDeps): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const { state, pos } = context;
    const line = state.doc.lineAt(pos);
    const lineBefore = line.text.slice(0, pos - line.from);
    const ctx = wikiContext(lineBefore);
    if (!ctx) return null;
    if (inCode(state, pos, lineBefore)) return null;
    if (ctx.heading) {
      // In a table cell editor the note is the outer editor's document, not the cell text.
      const outer = context.view ? outerOf(context.view) : undefined;
      return headingCompletions(deps, outer?.state ?? state, pos, ctx.heading);
    }
    const snap = deps.snapshot();
    if (!snap) return null;
    const source = deps.notePath();
    const items: PickItem<Row>[] = [];
    const details: string[] = [];
    for (const path of snap.files) {
      const isNote = /\.md$/i.test(path);
      if (!isNote && !(ctx.embed && IMAGE_EXTS.has(extOf(path)))) continue;
      const linktext = snap.resolver.linktextFor(path, source);
      if (linktext === null) continue;
      const folder = folderOf(path);
      const title = isNote ? snap.titles.get(path) : undefined;
      items.push({
        label: wikiBasename(path),
        description: folder,
        keywords: title !== undefined ? [title] : undefined,
        value: { linktext, alias: title },
      });
      details.push(title !== undefined ? `${title} · ${folder}` : folder);
    }
    for (const { path, alias } of snap.aliases) {
      const linktext = snap.resolver.linktextFor(path, source);
      if (linktext === null) continue;
      items.push({ label: alias, description: wikiBasename(path), value: { linktext, alias } });
      details.push(wikiBasename(path));
    }
    const detailOf = new Map(items.map((item, i) => [item, details[i]]));
    const ranked = rankPickItems(items, ctx.query).slice(0, COMPLETION_MAX);
    const from = pos - ctx.query.length;
    return {
      from,
      filter: false,
      options: ranked.map((item) => {
        const detail = detailOf.get(item);
        return { label: item.label, detail: detail === '' ? undefined : detail, apply: applyRow(item.value) };
      }),
    };
  };
}

function lineBeforeCursor(view: EditorView): string {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  return line.text.slice(0, head - line.from);
}

/** Enter or Tab that belongs to the IME while the completion list is open. */
function imeAcceptKey(event: KeyboardEvent, view: EditorView): boolean {
  if (event.key !== 'Enter' && event.key !== 'Tab') return false;
  if (!(view.composing || event.isComposing || event.keyCode === 229)) return false;
  return completionStatus(view.state) === 'active';
}

/**
 * IME guards (D9):
 * - Enter or Tab while the list is open and the IME is composing is left to the IME. CodeMirror calls
 *   `preventDefault()` for every DOM handler that returns true, so the guard is a capture-phase listener on
 *   `view.dom` (an ancestor of the content element) that stops the event before any CodeMirror handler sees it,
 *   without `preventDefault()`: the syllable commits and neither the completion keymap nor the list keys run.
 *   (CodeMirror already drops keys once it has seen `compositionstart`; this also covers a keydown that comes first.)
 * - after `compositionend`, the list is reopened when the cursor is inside `[[`, so the follow-up Enter accepts.
 */
export function wikiCompletionGuards(): Extension {
  return [
    ViewPlugin.define((view) => {
      const onKeydown = (event: KeyboardEvent) => {
        if (imeAcceptKey(event, view)) event.stopPropagation();
      };
      view.dom.addEventListener('keydown', onKeydown, true);
      return { destroy: () => view.dom.removeEventListener('keydown', onKeydown, true) };
    }),
    EditorView.domEventHandlers({
      compositionend: (_event, view) => {
        setTimeout(() => {
          if (view.dom.isConnected && wikiContext(lineBeforeCursor(view))) startCompletion(view);
        }, 0);
        return false;
      },
    }),
  ];
}
