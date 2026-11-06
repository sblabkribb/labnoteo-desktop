import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import {
  FORMAT_EVENT,
  type InlineMark,
  cycleTask,
  insertLink,
  setHeading,
  toggleInline,
  toggleLinePrefix,
  wrapCodeBlock,
} from '../format';

type Builder = (s: EditorState) => TransactionSpec | null;

/** `|` 가 선택을 표시한다(하나면 커서, 둘이면 범위). 편집기와 같은 마크다운 언어를 싣는다. */
function stateOf(src: string): EditorState {
  const at: number[] = [];
  let doc = '';
  for (const ch of src) {
    if (ch === '|') at.push(doc.length);
    else doc += ch;
  }
  const selection = at.length === 0 ? undefined : EditorSelection.range(at[0], at[1] ?? at[0]);
  return EditorState.create({ doc, selection, extensions: [EditorState.lineSeparator.of('\n'), labnoteMarkdown()] });
}

function show(state: EditorState): string {
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  return from === to ? doc.slice(0, from) + '|' + doc.slice(from) : doc.slice(0, from) + '|' + doc.slice(from, to) + '|' + doc.slice(to);
}

function apply(src: string, f: Builder): string {
  const s = stateOf(src);
  const spec = f(s);
  return spec ? show(s.update(spec).state) : show(s);
}

function docOf(src: string, f: Builder): string {
  const s = stateOf(src);
  const spec = f(s);
  return spec ? s.update(spec).state.doc.toString() : src;
}

describe('format builders', () => {
  it.each([
    ['a |b| c', '**', 'a **|b|** c'],
    ['a **|b|** c', '**', 'a |b| c'],
    ['a b|c', '*', 'a *|bc|*'],
    ['|', '`', '`|`'],
    ['한|글', '**', '**|한글|**'],
  ])('toggleInline %s %s', (src, mark, out) => expect(apply(src, (s) => toggleInline(s, mark as InlineMark))).toBe(out));

  it('toggleInline unwraps a selection that equals the node', () => expect(apply('a |**b**| c', (s) => toggleInline(s, '**'))).toBe('a |b| c'));
  it('toggleInline unwraps from inside with an empty cursor', () => expect(apply('a ==b|c== d', (s) => toggleInline(s, '=='))).toBe('a b|c d'));
  it('toggleInline unwraps from the outside text without a syntax tree', () => {
    const s = EditorState.create({ doc: 'x ~~y~~', selection: EditorSelection.range(4, 5) });
    expect(s.update(toggleInline(s, '~~')!).state.doc.toString()).toBe('x y');
  });
  it.each(['**', '`', '=='])('toggleInline %s again on an empty pair unwraps it', (mark) => {
    expect(apply('a | b', (s) => toggleInline(s, mark as InlineMark))).toBe(`a ${mark}|${mark} b`);
    expect(apply(`a ${mark}|${mark} b`, (s) => toggleInline(s, mark as InlineMark))).toBe('a | b');
  });
  it('toggleInline does not merge two adjacent runs at their seam', () =>
    expect(docOf('**a**|**b**', (s) => toggleInline(s, '**'))).not.toBe('**ab**'));
  it('italic does not strip one star of bold', () => expect(apply('a **|b|** c', (s) => toggleInline(s, '*'))).toBe('a ***|b|*** c'));

  it('insertLink wraps the selection and puts the cursor inside ()', () => expect(apply('a |b| c', insertLink)).toBe('a [b](|) c'));

  it('setHeading on "## a" with level 2 removes it', () => expect(apply('## |a', (s) => setHeading(s, 2))).toBe('|a'));
  it('setHeading on a one-line state works', () => expect(docOf('a', (s) => setHeading(s, 1))).toBe('# a'));
  it('setHeading replaces another level in place', () => expect(docOf('### a', (s) => setHeading(s, 1))).toBe('# a'));
  it('setHeading touches every selected line', () => expect(docOf('|a\nb|', (s) => setHeading(s, 2))).toBe('## a\n## b'));

  it('ordered list numbers 1., 2., 3.', () => expect(apply('|a\nb\nc|', (s) => toggleLinePrefix(s, 'ordered'))).toBe('|1. a\n2. b\n3. c|'));
  it('bullet on a plain line, cursor after the prefix', () => expect(apply('|a', (s) => toggleLinePrefix(s, 'bullet'))).toBe('- |a'));
  it('bullet again removes it', () => expect(docOf('- a', (s) => toggleLinePrefix(s, 'bullet'))).toBe('a'));

  it('cycleTask: plain → "- [ ] " → "- [x] " → "- [ ] "', () => {
    expect(docOf('a', cycleTask)).toBe('- [ ] a');
    expect(docOf('- [ ] a', cycleTask)).toBe('- [x] a');
    expect(docOf('- [x] a', cycleTask)).toBe('- [ ] a');
  });

  it('builders convert an existing marker in place', () => {
    expect(docOf('- a', cycleTask)).toBe('- [ ] a');
    expect(docOf('1. a', (s) => toggleLinePrefix(s, 'bullet'))).toBe('- a');
    expect(docOf('  - [x] a', (s) => toggleLinePrefix(s, 'bullet'))).toBe('  - a');
    expect(docOf('> a', (s) => toggleLinePrefix(s, 'quote'))).toBe('a');
  });

  it('cycleTask keeps an ordered marker and adds the box after it', () => expect(docOf('1. a', cycleTask)).toBe('1. [ ] a'));
  it('line prefixes in a mixed-EOL buffer keep the \\r line endings', () => {
    expect(docOf('|a\r\nb\nc|', (s) => toggleLinePrefix(s, 'bullet'))).toBe('- a\r\n- b\n- c');
    expect(docOf('- [ ] a\r\nb', cycleTask)).toBe('- [x] a\r\nb');
  });
  it('line builders fall back to the same rules without a syntax tree', () => {
    const s = EditorState.create({ doc: '  * [X] a' });
    expect(s.update(cycleTask(s)!).state.doc.toString()).toBe('  * [ ] a');
    expect(s.update(toggleLinePrefix(s, 'ordered')!).state.doc.toString()).toBe('  1. a');
  });

  describe('front matter and SP1 tables are left alone', () => {
    const fm = '|---\ntitle: a\n---\nbody|';
    it.each<[string, Builder, string]>([
      ['setHeading', (s) => setHeading(s, 1), '---\ntitle: a\n---\n# body'],
      ['bullet', (s) => toggleLinePrefix(s, 'bullet'), '---\ntitle: a\n---\n- body'],
      ['quote', (s) => toggleLinePrefix(s, 'quote'), '---\ntitle: a\n---\n> body'],
      ['cycleTask', cycleTask, '---\ntitle: a\n---\n- [ ] body'],
      ['wrapCodeBlock', wrapCodeBlock, '---\ntitle: a\n---\n```\nbody\n```'],
    ])('select-all %s skips the front matter', (_n, f, out) => expect(docOf(fm, f)).toBe(out));

    /** 표의 `|` 가 선택 표시와 겹치므로 선택은 [from, to] 로 따로 준다(to 가 없으면 문서 끝). */
    function onTable(doc: string, f: Builder, from = 0, to = doc.length): string {
      const s = EditorState.create({ doc, selection: EditorSelection.range(from, to), extensions: [EditorState.lineSeparator.of('\n'), labnoteMarkdown()] });
      const spec = f(s);
      return spec ? s.update(spec).state.doc.toString() : doc;
    }
    const table = '| a | b |\n| - | - |\n| 1 | 2 |\n\ntext';
    it.each<[string, Builder, string]>([
      ['setHeading', (s) => setHeading(s, 1), '| a | b |\n| - | - |\n| 1 | 2 |\n\n# text'],
      ['bullet', (s) => toggleLinePrefix(s, 'bullet'), '| a | b |\n| - | - |\n| 1 | 2 |\n\n- text'],
      ['cycleTask', cycleTask, '| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] text'],
      ['wrapCodeBlock', wrapCodeBlock, '| a | b |\n| - | - |\n| 1 | 2 |\n\n```\ntext\n```'],
    ])('select-all %s skips table rows', (_n, f, out) => expect(onTable(table, f)).toBe(out));

    it('a builder touching only front matter or a table row changes nothing', () => {
      expect(apply('---\nti|tle: a\n---\nbody', (s) => setHeading(s, 1))).toBe('---\nti|tle: a\n---\nbody');
      const t = '| a | b |\n| - | - |\n| 1 | 2 |';
      expect(onTable(t, wrapCodeBlock, 22, 22)).toBe(t);
      expect(onTable(t, (s) => setHeading(s, 1), 22, 22)).toBe(t);
    });
    it('without a syntax tree a leading ---…--- block is still skipped', () => {
      const s = EditorState.create({ doc: '---\nt: a\n---\nb', selection: EditorSelection.range(0, 14) });
      expect(s.update(setHeading(s, 1)!).state.doc.toString()).toBe('---\nt: a\n---\n# b');
    });
  });

  it('mixed quote+list prefixes do not stack', () => {
    expect(docOf('> - a', (s) => toggleLinePrefix(s, 'bullet'))).toBe('> a');
    expect(docOf('> - a', (s) => toggleLinePrefix(s, 'ordered'))).toBe('> 1. a');
    expect(docOf('> - a', cycleTask)).toBe('> - [ ] a');
    expect(docOf('> - a', (s) => toggleLinePrefix(s, 'quote'))).toBe('- a');
    const s = EditorState.create({ doc: '> - a' });
    expect(s.update(cycleTask(s)!).state.doc.toString()).toBe('> - [ ] a');
    expect(s.update(toggleLinePrefix(s, 'bullet')!).state.doc.toString()).toBe('> a');
  });

  it('a new prefix goes after the leading indentation', () => {
    expect(docOf('  b', (s) => toggleLinePrefix(s, 'bullet'))).toBe('  - b');
    expect(docOf('  b', cycleTask)).toBe('  - [ ] b');
    expect(docOf('  b', (s) => setHeading(s, 2))).toBe('  ## b');
  });

  it('wrapCodeBlock in a CRLF state uses \r\n breaks', () => {
    const s = EditorState.create({ doc: 'a\r\nb', selection: EditorSelection.range(0, 3), extensions: EditorState.lineSeparator.of('\r\n') }); // a lineSeparator state splits the doc string on that separator only
    expect(s.update(wrapCodeBlock(s)!).state.sliceDoc()).toBe('```\r\na\r\nb\r\n```');
  });

  it('a multi-range selection is one transaction', () => {
    const s = EditorState.create({ doc: 'a b', selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)]), extensions: EditorState.allowMultipleSelections.of(true) });
    const tr = s.update(toggleInline(s, '**')!);
    expect(tr.state.doc.toString()).toBe('**a** **b**');
  });

  it('every builder isolates history and is null when read-only', () => {
    const s = EditorState.create({ doc: 'a', selection: EditorSelection.range(0, 1) });
    expect(s.update(toggleInline(s, '**')!).annotation(isolateHistory)).toBe('full');
    expect(toggleInline(EditorState.create({ doc: 'a', extensions: EditorState.readOnly.of(true) }), '**')).toBeNull();

    const builders: Builder[] = [
      (x) => toggleInline(x, '**'),
      insertLink,
      (x) => setHeading(x, 1),
      (x) => toggleLinePrefix(x, 'bullet'),
      cycleTask,
      wrapCodeBlock,
    ];
    const ro = EditorState.create({ doc: 'a', extensions: EditorState.readOnly.of(true) });
    for (const b of builders) {
      const tr = s.update(b(s)!);
      expect(tr.annotation(isolateHistory)).toBe('full');
      expect(tr.isUserEvent(FORMAT_EVENT)).toBe(true);
      expect(b(ro)).toBeNull();
    }
  });
});
