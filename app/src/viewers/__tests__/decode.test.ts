import { decodeText } from '../decode';

describe('decodeText', () => {
  it('reads UTF-8 and drops the BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('시료,값')]);
    expect(decodeText(bytes)).toEqual({ text: '시료,값', encoding: 'utf-8' });
  });

  it('falls back to EUC-KR when the bytes are not UTF-8', () => {
    // "시료" in EUC-KR (CP949)
    const bytes = new Uint8Array([0xbd, 0xc3, 0xb7, 0xe1, 0x2c, 0x31]);
    expect(decodeText(bytes)).toEqual({ text: '시료,1', encoding: 'euc-kr' });
  });
});
