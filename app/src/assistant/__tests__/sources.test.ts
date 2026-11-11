/**
 * 출처 장부(assistant spec §4.5): 도구가 내준 출처에 [n] 번호를 붙이고, 답의 [n] 을 장부에 있는 것만 링크로 만든다.
 */
import { describe, expect, it } from 'vitest';
import { SOURCE_LABEL_MAX, SourceLedger, textWithSources, type Source } from '../sources';

const note = (path: string, label = path): Source => ({ kind: 'note', label, target: path });
const web = (url: string, label = url): Source => ({ kind: 'web', label, target: url });

describe('SourceLedger.add', () => {
  it('numbers sources from 1 in order and gives the same number to the same target', () => {
    const l = new SourceLedger();
    expect(l.add(note('labnote/001_A/README.labnote.md'))).toBe(1);
    expect(l.add(web('https://example.org/a'))).toBe(2);
    expect(l.add(note('labnote/001_A/README.labnote.md', 'other label'))).toBe(1);
    expect(l.list().map((s) => s.target)).toEqual(['labnote/001_A/README.labnote.md', 'https://example.org/a']);
    expect(l.get(2)).toEqual({ kind: 'web', label: 'https://example.org/a', target: 'https://example.org/a' });
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///C:/Windows/win.ini',
    'mailto:a@b.c',
    'partbank://x',
    'https://user:pw@example.org/',
    'not a url',
    '',
  ])('refuses the web/paper target %j (returns 0, adds nothing)', (target) => {
    const l = new SourceLedger();
    expect(l.add(web(target))).toBe(0);
    expect(l.add({ kind: 'paper', label: 'p', target })).toBe(0);
    expect(l.list()).toEqual([]);
  });

  it.each([
    'javascript:alert(1)',
    'C:/Vault/a.md',
    '/etc/passwd',
    String.raw`\\server\share\a.md`,
    'labnote/../secret.md',
    '..',
    'a\u0000b.md',
    '',
    'https://example.org/a',
  ])('refuses the note target %j', (target) => {
    const l = new SourceLedger();
    expect(l.add(note(target))).toBe(0);
    expect(l.list()).toEqual([]);
  });

  it('accepts Korean vault paths and http/https URLs, keeping the URL as parsed', () => {
    const l = new SourceLedger();
    expect(l.add(note('labnote/001_대장균/README.labnote.md'))).toBe(1);
    expect(l.add({ kind: 'paper', label: 'DOI', target: 'https://doi.org/10.1000/xyz' })).toBe(2);
    expect(l.add(web('http://example.org/검색?q=1'))).toBe(3);
    expect(l.get(3)!.target).toBe('http://example.org/%EA%B2%80%EC%83%89?q=1');
  });

  it('strips control and bidi characters from the label, caps it, and falls back to the target', () => {
    const l = new SourceLedger();
    l.add(web('https://a.example/', 'Ti\u202Etle\u0007\n2'));
    l.add(web('https://b.example/', '   '));
    l.add(web('https://c.example/', 'x'.repeat(5000)));
    expect(l.get(1)!.label).toBe('Title 2');
    expect(l.get(2)!.label).toBe('https://b.example/');
    expect(l.get(3)!.label.length).toBe(SOURCE_LABEL_MAX);
  });

  it('from() rebuilds a ledger from a stored list, dropping refused entries', () => {
    const l = SourceLedger.from([note('labnote/001_A/a.md'), web('javascript:x'), web('https://e.org/')]);
    expect(l.list().map((s) => s.target)).toEqual(['labnote/001_A/a.md', 'https://e.org/']);
  });
});

describe('SourceLedger.render', () => {
  const ledger = () => {
    const l = new SourceLedger();
    l.add(note('labnote/001_A/a.md'));
    l.add(web('https://e.org/'));
    return l;
  };

  it('turns known [n] into citation parts and keeps the rest as text', () => {
    const l = ledger();
    expect(l.render('PCR 조건은 [1] 과 [2] 에 있어요.')).toEqual([
      'PCR 조건은 ',
      { n: 1, src: l.get(1) },
      ' 과 ',
      { n: 2, src: l.get(2) },
      ' 에 있어요.',
    ]);
  });

  it('an unknown [3] stays plain text', () => {
    expect(ledger().render('see [3] and [0]')).toEqual(['see [3] and [0]']);
  });

  it('a number with a leading zero is not a citation: [01] and [001] stay text', () => {
    const l = ledger();
    expect(l.render('[01] [001] [1]')).toEqual(['[01] [001] ', { n: 1, src: l.get(1) }]);
  });

  it('an empty ledger renders the text unchanged', () => {
    expect(new SourceLedger().render('[1]')).toEqual(['[1]']);
    expect(new SourceLedger().render('')).toEqual([]);
  });

  it('does not read markup: [1](javascript:x) only links the known number, the rest stays text', () => {
    const l = ledger();
    expect(l.render('[1](javascript:x)')).toEqual([{ n: 1, src: l.get(1) }, '(javascript:x)']);
  });
});

describe('textWithSources ("Insert into note")', () => {
  const ledger = () =>
    SourceLedger.from([
      note('resources/workflows/workflows_en.json#WB150', '카탈로그 · WB150 PCR-based Target Amplification'),
      web('https://example.org/a b', 'Thermo [guide]'),
      note('labnote/001_A/README.labnote.md', 'README.labnote.md'),
    ]);

  it('appends the sources the answer cites, in number order, so no [n] in the note dangles', () => {
    const text = 'PCR 을 돌립니다 [2]. 카탈로그 기준입니다 [1]. 다시 [2].';
    expect(textWithSources(text, ledger(), '출처')).toBe(
      [
        text,
        '',
        '출처:',
        '- [1] 카탈로그 · WB150 PCR-based Target Amplification',
        '- [2] [Thermo (guide)](<https://example.org/a%20b>)',
      ].join('\n'),
    );
  });

  it('leaves an answer without ledger citations as it is', () => {
    expect(textWithSources('인용 없음 [9]', ledger(), '출처')).toBe('인용 없음 [9]');
    expect(textWithSources('그냥 답', new SourceLedger(), '출처')).toBe('그냥 답');
  });
});
