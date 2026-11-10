import { isNumericColumn, parseCsv } from '../csv';

describe('parseCsv', () => {
  it('strips the BOM and splits header and rows on commas', () => {
    const r = parseCsv('\uFEFFwell,od600\r\nA1,0.52\r\nA2,0.61\r\n');
    expect(r.delimiter).toBe(',');
    expect(r.header).toEqual(['well', 'od600']);
    expect(r.rows).toEqual([
      ['A1', '0.52'],
      ['A2', '0.61'],
    ]);
  });

  it('sniffs semicolons and tabs', () => {
    expect(parseCsv('a;b;c\n1;2,5;3').delimiter).toBe(';');
    expect(parseCsv('a;b;c\n1;2,5;3').rows).toEqual([['1', '2,5', '3']]);
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['1', '2']]);
  });

  it('a tsv hint wins over sniffing', () => {
    expect(parseCsv('a,b\tc\n1,2\t3', '\t').header).toEqual(['a,b', 'c']);
  });

  it('handles quoted commas, doubled quotes and newlines inside quotes (RFC 4180)', () => {
    const r = parseCsv('name,note\n"Lee, J","said ""hi"""\n"x","two\nlines"\n');
    expect(r.rows).toEqual([
      ['Lee, J', 'said "hi"'],
      ['x', 'two\nlines'],
    ]);
  });

  it('pads ragged rows to the widest row and keeps empty cells', () => {
    const r = parseCsv('a,b,c\n1\n1,,3,4');
    expect(r.header).toEqual(['a', 'b', 'c', '']);
    expect(r.rows).toEqual([
      ['1', '', '', ''],
      ['1', '', '3', '4'],
    ]);
  });

  it('an empty text is an empty table', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [], delimiter: ',' });
  });
});

describe('isNumericColumn', () => {
  it('is true when every non-empty cell is a number', () => {
    const rows = [
      ['A1', '0.52', '1e3', ''],
      ['A2', '-1', '12%', ''],
      ['B1', '', '3', ''],
    ];
    expect(isNumericColumn(rows, 0)).toBe(false);
    expect(isNumericColumn(rows, 1)).toBe(true);
    expect(isNumericColumn(rows, 2)).toBe(true);
    expect(isNumericColumn(rows, 3)).toBe(false);
  });
});
