import { currentItem, extractOutline, toTree, type OutlineItem } from '../extract';
import { clearOutline, getOutline, publishCursor, publishOutline } from '../outlineStore';

describe('extractOutline', () => {
  it('extracts UO headings with codes and skips fenced code and front matter', () => {
    expect(extractOutline('---\ntitle: x\n---\n## [WB030 Cloning]\n### [UHW010 PCR] alias\n```\n# not\n```\n#### Meta\n')).toEqual([
      { level: 2, text: 'Cloning', code: 'WB030', kind: 'workflow', line: 4 },
      { level: 3, text: 'PCR alias', code: 'UHW010', kind: 'unitOp', line: 5 },
      { level: 4, text: 'Meta', kind: 'heading', line: 9 },
    ]);
  });

  it('CRLF headings parse without trailing \r', () => expect(extractOutline('# a\r\n## b\r\n').map((i) => i.text)).toEqual(['a', 'b']));

  it('a line array keeps its own numbering (a lone LF inside a CRLF-split line does not add a line)', () =>
    expect(extractOutline(['a', 'b\nc', 'd', '## H', 'x'])).toEqual([{ level: 2, text: 'H', kind: 'heading', line: 4 }]));

  it('finds a heading at line 5000 of a long note', () => {
    const text = 'x\n'.repeat(4999) + '### [UHW010 PCR]\n';
    expect(extractOutline(text)).toEqual([{ level: 3, text: 'PCR', code: 'UHW010', kind: 'unitOp', line: 5000 }]);
  });

  it('strips closing #s, ignores non-headings and tilde fences, skips empty headings and keeps a dot-closed front matter out', () => {
    expect(
      extractOutline('---\n# in yaml\n...\n#tag\n## Title ##\n~~~\n## no\n~~~\n    # indented code\n####### seven\n#\n'),
    ).toEqual([{ level: 2, text: 'Title', kind: 'heading', line: 5 }]);
  });

  it('a fence opened with four backticks closes only with four or more', () => {
    expect(extractOutline('````\n```\n# no\n````\n# yes\n').map((i) => i.line)).toEqual([5]);
  });
});

describe('toTree and currentItem', () => {
  const items: OutlineItem[] = [
    { level: 2, text: 'Cloning', code: 'WB030', kind: 'workflow', line: 2 },
    { level: 3, text: 'PCR', code: 'UHW010', kind: 'unitOp', line: 4 },
    { level: 4, text: 'Meta', kind: 'heading', line: 6 },
    { level: 2, text: 'Next', kind: 'heading', line: 9 },
  ];

  it('nests by level with the line as id', () => {
    const tree = toTree(items);
    expect(tree.map((n) => n.id)).toEqual(['2', '9']);
    expect(tree[0].kind).toBe('workflow');
    expect(tree[0].label).toBe('WB030 Cloning');
    expect(tree[0].children![0].kind).toBe('unitOperation');
    expect(tree[0].children![0].children![0]).toMatchObject({ id: '6', label: 'Meta', kind: 'category' });
    expect(tree[1].children).toBeUndefined();
  });

  it('currentItem is the last item at or above the cursor', () => {
    expect(currentItem(items, 1)).toBeUndefined();
    expect(currentItem(items, 4)?.line).toBe(4);
    expect(currentItem(items, 8)?.line).toBe(6);
    expect(currentItem(items, 100)?.line).toBe(9);
  });
});

describe('outline store', () => {
  afterEach(() => clearOutline('n.md'));

  it('keeps the cursor for the same note and clears only its own note', () => {
    publishOutline('n.md', [{ level: 1, text: 'a', kind: 'heading', line: 1 }]);
    publishCursor('n.md', 3);
    publishOutline('n.md', []);
    expect(getOutline()).toEqual({ path: 'n.md', items: [], cursorLine: 3 });
    clearOutline('other.md');
    expect(getOutline()?.path).toBe('n.md');
    clearOutline('n.md');
    expect(getOutline()).toBeUndefined();
  });
});
