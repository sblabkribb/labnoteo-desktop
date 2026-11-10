/**
 * 보기 화면이 읽은 바이트를 글로(계획 R6): 먼저 UTF-8(틀린 바이트가 있으면 실패, BOM 은 뗀다), 아니면 EUC-KR(CP949,
 * 옛 한글 Windows 의 Excel 이 쓰는 CSV). DOM 을 쓰지 않아 CSV Worker 안에서도 돈다(Task 14).
 */
export type TextEncodingName = 'utf-8' | 'euc-kr';

export function decodeText(bytes: ArrayBuffer | Uint8Array): { text: string; encoding: TextEncodingName } {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('euc-kr').decode(view), encoding: 'euc-kr' };
  }
}
