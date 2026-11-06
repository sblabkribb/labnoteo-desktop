import { isTabular, parseTSV, toTSV } from '../tsv';

describe('parseTSV', () => {
  it.each([
    ['a\tb', [['a', 'b']]],
    ['a\tb\r\nc\td\r\n', [['a', 'b'], ['c', 'd']]], // Excel: CRLF, 끝의 빈 줄은 버린다
    ['a\tb\nc\td', [['a', 'b'], ['c', 'd']]],
    ['a\t\tc', [['a', '', 'c']]],
    ['"x\r\ny"\tz', [['x\r\ny', 'z']]], // 따옴표 안의 줄바꿈은 셀 안에 남는다
    ['"say ""hi"""\t1', [['say "hi"', '1']]],
    ['a"b\tc', [['a"b', 'c']]], // 셀 중간의 따옴표는 글자 그대로
    ['007\t1/2\t2E4', [['007', '1/2', '2E4']]], // 값을 바꾸지 않는다
    ['시료\t농도\n대장균\t1 mM', [['시료', '농도'], ['대장균', '1 mM']]],
    ['a\tb\n\n', [['a', 'b'], ['']]], // 마지막 빈 줄 하나만 버린다
    ['', []],
  ])('%j', (text, grid) => {
    expect(parseTSV(text)).toEqual(grid);
  });
});

describe('isTabular', () => {
  it.each([
    ['a\tb', true],
    ['a\nb', false], // 탭이 없으면 표가 아니다
    ['a', false],
    ['a\t', true], // 셀 두 개(두 번째는 빈 칸)
    ['', false],
    ['x\r\ny\tz', true],
  ])('%j -> %s', (text, want) => {
    expect(isTabular(text)).toBe(want);
  });
});

describe('toTSV', () => {
  it('joins cells with tabs and rows with CRLF', () => {
    expect(toTSV([['a', 'b'], ['c', 'd']])).toBe('a\tb\r\nc\td');
  });

  it('quotes cells with tabs, line breaks or quotes', () => {
    expect(toTSV([['a\tb', 'x\ny', 'say "hi"', 'plain']])).toBe('"a\tb"\t"x\ny"\t"say ""hi"""\tplain');
  });

  it('round-trips through parseTSV', () => {
    const grid = [['a\tb', '', '시료'], ['x\r\ny', '"q"', '007']];
    expect(parseTSV(toTSV(grid))).toEqual(grid);
  });
});
