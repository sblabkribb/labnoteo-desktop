/**
 * 확인 창의 문단은 앞 공백을 지킨다. 에이전트 승인 창(SP6)이 들여쓴 diff 줄을 그대로 보여 줘야 한다.
 */
import { readFileSync } from 'node:fs';

describe('confirm message whitespace', () => {
  it('confirm paragraphs keep leading spaces (approval diffs)', () => {
    const css = readFileSync('src/styles/dialogs.css', 'utf-8');
    expect(css).toMatch(/\.confirm-message p \{[^}]*white-space: pre-wrap/);
    expect(css).not.toMatch(/\.confirm-message p \{[^}]*pre-line/);
  });
});
