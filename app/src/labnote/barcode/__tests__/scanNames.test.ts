import { describe, expect, it } from 'vitest';
import { isScanOfNote, noteIdFromFiledScanEmbed, scanFileName } from '../../port/scanNames';

// vendor tests/plugin/barcode.test.ts:111-166 의 스캔 파일 이름 경우 가운데 이 세 함수를 쓰는 것.
describe('scan file names', () => {
  it("names a scan after its note, unit operation and page, so moves can find a note's scans", () => {
    const name = scanFileName('LN-7K3M9QX2', 3, 2, '2026-10-15');
    expect(name).toBe('LN-7K3M9QX2_u3_p2_20261015.jpg');
    expect(isScanOfNote(name, 'LN-7K3M9QX2')).toBe(true);
    expect(isScanOfNote('LN-7K3M9QX2_u3_p2_20261015_2.jpg', 'LN-7K3M9QX2')).toBe(true);
    expect(isScanOfNote(name, 'LN-00000000')).toBe(false);
    expect(isScanOfNote('LN-7K3M9QX2_notes.md', 'LN-7K3M9QX2')).toBe(false);
  });

  it('reads the note ID from a filed scan embed, with or without a folder or as a Markdown link', () => {
    expect(noteIdFromFiledScanEmbed('![[LN-7K3M9QX2_u3_p2_20261015.jpg|200]]')).toBe('LN-7K3M9QX2');
    expect(noteIdFromFiledScanEmbed('![[images/scans/LN-7K3M9QX2_u0_p1_20261015_2.png]]')).toBe('LN-7K3M9QX2');
    expect(noteIdFromFiledScanEmbed('![](images/scans/LN-7K3M9QX2_u3_p2_20261015.jpeg)')).toBe('LN-7K3M9QX2');
    expect(noteIdFromFiledScanEmbed('![[plot.png]]')).toBeUndefined();
    expect(noteIdFromFiledScanEmbed('![[xLN-7K3M9QX2_u3_p2_20261015.jpg]]')).toBeUndefined();
    expect(noteIdFromFiledScanEmbed('![[LN-7K3M9QX2_notes.jpg]]')).toBeUndefined();
  });
});
