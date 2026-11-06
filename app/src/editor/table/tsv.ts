/**
 * 탭으로 나눈 글(TSV)을 읽고 쓴다. Excel 이 클립보드 text/plain 에 넣는 형식:
 * 칸은 `\t`, 줄은 `\r\n`(또는 `\n`), 탭·줄바꿈·따옴표가 든 칸은 `"…"` 로 감싸고 `"` 는 `""` 로 적는다.
 * 값은 바꾸지 않는다(`007`, `1/2`, `2E4` 그대로).
 */

/** TSV 를 칸 격자로 읽는다. 끝의 빈 줄 하나는 버린다. */
export function parseTSV(text: string): string[][] {
  const out: string[][] = [];
  const n = text.length;
  if (n === 0) return out;
  let row: string[] = [];
  let i = 0;
  for (;;) {
    let value = '';
    if (text[i] === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i++];
      }
    }
    // 따옴표가 없는 칸, 또는 닫는 따옴표 뒤에 남은 글자
    while (i < n && text[i] !== '\t' && text[i] !== '\n' && text[i] !== '\r') value += text[i++];
    row.push(value);
    if (i >= n) {
      out.push(row);
      break;
    }
    if (text[i] === '\t') {
      i++;
      continue;
    }
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    out.push(row);
    row = [];
    if (i >= n) break; // 끝의 줄바꿈: 빈 마지막 줄을 만들지 않는다
  }
  return out;
}

/** 칸이 둘 이상이고 탭이 하나라도 있으면 표로 붙여 넣을 글이다. */
export function isTabular(text: string): boolean {
  if (!text.includes('\t')) return false;
  let cells = 0;
  for (const r of parseTSV(text)) cells += r.length;
  return cells >= 2;
}

const quote = (v: string) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** 칸 격자를 Excel 이 읽는 TSV 로 쓴다(줄은 `\r\n`, 끝 줄바꿈 없음). */
export function toTSV(cells: string[][]): string {
  return cells.map((r) => r.map(quote).join('\t')).join('\r\n');
}

/**
 * `pasteRect(m, r, c, grid, br)`: `grid` 를 표의 (r, c) 칸부터 채운다. 필요하면 행과 열을 늘리고,
 * 값은 앞뒤 공백을 떼고 escape 한다. 표 모델의 내부(행 끝 덧붙이기 등)를 쓰므로 model.ts 에 있다.
 */
export { pasteRect } from './model';
