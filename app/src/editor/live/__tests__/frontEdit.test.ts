import { EditorState, type ChangeSpec, type TransactionSpec } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { parseFrontMatterYaml } from '@labnoteo/core';
import { labnoteMarkdown } from '../../markdownSyntax';
import { frontMatterText } from '../../../labnote/frontMatterText';
import { addKey, editValue, isWikilinkValue, keyOfLine, keySpan, READ_ONLY_KEYS, removeKey, renameKey, yamlKey } from '../frontEdit';

function st(doc: string, opts: { lineSeparator?: string } = {}): EditorState {
  return EditorState.create({
    doc,
    extensions: [labnoteMarkdown(), opts.lineSeparator ? EditorState.lineSeparator.of(opts.lineSeparator) : []],
  });
}
const apply = (doc: string, spec: TransactionSpec) => st(doc).update(spec).state.doc.toString();
function docOf(doc: string, f: (s: EditorState) => TransactionSpec | null): string {
  const spec = f(st(doc));
  expect(spec).not.toBeNull();
  return apply(doc, spec!);
}
function changedRange(spec: TransactionSpec): { from: number; to: number } {
  const c = spec.changes as ChangeSpec & { from: number; to?: number };
  return { from: c.from, to: c.to ?? c.from };
}
const L = (...lines: string[]) => lines.join('\n');
const parses = (text: string) => !parseFrontMatterYaml(frontMatterText(text)).parseError;

describe('속성 격자의 최소 편집(frontEdit)', () => {
  it('reads keys and their tokens', () => {
    expect(keyOfLine('담당자: a')).toMatchObject({ key: '담당자', token: '담당자' });
    expect(keyOfLine('sample id : 1')).toMatchObject({ key: 'sample id', token: 'sample id' });
    expect(keyOfLine('"a.b": 2')).toMatchObject({ key: 'a.b', token: '"a.b"' });
    expect(keyOfLine(String.raw`'it''s': 2`)).toMatchObject({ key: String.raw`it's`, token: String.raw`'it''s'` });
    expect(keyOfLine('  - a')).toBeNull();
    expect(keyOfLine('# c: d')).toBeNull();
    expect(READ_ONLY_KEYS.has('last_updated_date')).toBe(true);
  });

  it('keySpan covers continuation lines', () => {
    const text = ['---', 'tags:', '  - a', '  - b', 'x: 1', '---'].join('\n');
    expect(keySpan(text, 'tags')).toEqual({ from: 4, lineTo: 9, to: 21, token: 'tags' });
    expect(keySpan(text, 'x')).toEqual({ from: 22, lineTo: 26, to: 26, token: 'x' });
    expect(keySpan(text, 'nope')).toBeNull();
  });

  it('yamlKey quotes only when needed', () => {
    expect(yamlKey('시료')).toBe('시료');
    expect(yamlKey('sample id')).toBe('sample id');
    expect(yamlKey('a: b')).toBe('"a: b"');
    expect(yamlKey('#x')).toBe('"#x"');
  });

  it('isWikilinkValue', () => {
    expect(isWikilinkValue([' [[a]]'])).toBe(true);
    expect(isWikilinkValue(['', '  - "[[a]]"', '  - [[b]]'])).toBe(true);
    expect(isWikilinkValue([' a'])).toBe(false);
  });

  it('a value edit is a minimal change that keeps comments', () => {
    const doc = '---\n# c\ntitle: a\nstatus: Planned\n---\nbody';
    const spec = editValue(st(doc), 'title', 'b')!;
    expect(apply(doc, spec)).toBe('---\n# c\ntitle: b\nstatus: Planned\n---\nbody');
    expect(changedRange(spec)).toEqual({ from: 15, to: 16 });
  });

  it('editing a Korean front-matter key never duplicates it', () => {
    const out = docOf('---\n담당자: a\nb: 1\n---\nx', (s) => editValue(s, '담당자', '이서연'));
    expect(out).toBe('---\n담당자: 이서연\nb: 1\n---\nx');
    expect(out.match(/담당자:/g)).toHaveLength(1);
    expect(parses(out)).toBe(true);
  });

  it.each([
    ['---\nsample id: 1\n---\nx', 'sample id', '---\nsample id: 2\n---\nx'],
    ['---\n"a.b": 1\n---\nx', 'a.b', '---\n"a.b": 2\n---\nx'],
    ['---\na: 1 # keep\n---\nx', 'a', '---\na: 2 # keep\n---\nx'],
  ])('edits %j in place', (doc, key, out) => expect(docOf(doc, (s) => editValue(s, key, '2'))).toBe(out));

  it('a value that YAML would read differently is quoted', () => {
    const out = docOf('---\na: 1\n---\nx', (s) => editValue(s, 'a', 'b # c'));
    expect(parseFrontMatterYaml(frontMatterText(out)).frontMatter.a).toBe('b # c');
    expect(docOf('---\na: 1\n---\nx', (s) => editValue(s, 'a', ''))).toBe('---\na: \n---\nx');
    expect(editValue(st('---\na: 1\n---\nx'), 'a', '1')).toBeNull();
  });

  it('list values round-trip as YAML lists', () => {
    expect(docOf(L('---', 'tags:', '  - a', '  - b', '---', 'x'), (s) => editValue(s, 'tags', 'a, c'))).toBe(L('---', 'tags:', '  - a', '  - c', '---', 'x'));
  });

  it('editing an author wikilink keeps it unquoted', () => {
    expect(docOf('---\nauthor: [[이서연]]\n---\nx', (s) => editValue(s, 'author', '[[새이름]]'))).toBe('---\nauthor: [[새이름]]\n---\nx');
    expect(docOf('---\nauthor: [[이서연]]\n---\nx', (s) => editValue(s, 'author', '새이름'))).toBe('---\nauthor: [[새이름]]\n---\nx');
    const two = docOf('---\nauthor: [[이서연]]\n---\nx', (s) => editValue(s, 'author', '가, 나'));
    expect(two).toBe(L('---', 'author:', '  - "[[가]]"', '  - "[[나]]"', '---', 'x'));
    expect(parses(two)).toBe(true);
  });

  it('read-only and nested keys are not edited', () => {
    expect(editValue(st('---\nlast_updated_date: 2026-11-01\n---\nx'), 'last_updated_date', '2026-11-02')).toBeNull();
    expect(editValue(st(['---', 'a:', '  b: 1', '---', 'x'].join('\n')), 'a', '2')).toBeNull();
    expect(editValue(st('x'), 'a', '2')).toBeNull();
    expect(removeKey(st('---\nlast_updated_date: 2026-11-01\n---\nx'), 'last_updated_date')).toBeNull();
  });

  it('removeKey and addKey with Korean keys', () => {
    expect(docOf('---\n담당자: a\nb: 1\n---\nx', (s) => removeKey(s, '담당자'))).toBe('---\nb: 1\n---\nx');
    expect(docOf(L('---', 'tags:', '  - a', 'b: 1', '---', 'x'), (s) => removeKey(s, 'tags'))).toBe('---\nb: 1\n---\nx');
    expect(docOf('---\na: 1\n---\nx', (s) => addKey(s, '시료', 's1'))).toBe('---\na: 1\n시료: s1\n---\nx');
    expect(docOf('---\n---\nx', (s) => addKey(s, 'a', '1'))).toBe('---\na: 1\n---\nx');
    expect(addKey(st('---\na: 1\n---\nx'), 'a', '2')).toBeNull();
    expect(addKey(st('---\na: 1\n---\nx'), 'a: b', '2')).toBeNull();
  });

  it('renaming a key in a commented block changes one line', () => {
    expect(docOf('---\n# c\ntitle: a # keep\n---\nx', (s) => renameKey(s, 'title', '제목'))).toBe('---\n# c\n제목: a # keep\n---\nx');
    expect(renameKey(st('---\na: 1\nb: 2\n---\nx'), 'a', 'b')).toBeNull();
    expect(renameKey(st('---\na: 1\n---\nx'), 'a', 'c: d')).toBeNull();
  });

  it('an edit to a CRLF note keeps CRLF and changes only the value bytes', () => {
    const s = st('---\r\na: 1\r\n---\r\nx', { lineSeparator: '\r\n' });
    expect(s.update(editValue(s, 'a', '2')!).state.sliceDoc()).toBe('---\r\na: 2\r\n---\r\nx');
    const l = st(['---', 'tags:', '  - a', '---', 'x'].join('\r\n'), { lineSeparator: '\r\n' });
    expect(l.update(editValue(l, 'tags', 'a, b')!).state.sliceDoc()).toBe(['---', 'tags:', '  - a', '  - b', '---', 'x'].join('\r\n'));
  });

  it('one commit is one undo step with userEvent input.properties', () => {
    const tr = st('---\na: 1\n---\nx').update(editValue(st('---\na: 1\n---\nx'), 'a', '2')!);
    expect(tr.isUserEvent('input.properties')).toBe(true);
    expect(tr.annotation(isolateHistory)).toBe('full');
  });
});
