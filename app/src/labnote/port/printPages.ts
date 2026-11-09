// Ported from app/vendor/labnoteo/src/print/printPages.ts:39-41 sha256:961a463af0fd247e
// labnoteO 0.140.2, Apache-2.0.
// Changes: only escapeHtml (texHtml imports it); Task 6 ports the rest of printPages.ts:14-158 into this file.
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
