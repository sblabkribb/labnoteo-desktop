import { readFileSync } from 'node:fs';
import { declarations, parseRules } from './css';

/**
 * 설정 줄(dialogs.css)의 배치 지킴이(Task 22 실앱 점검): 조작이 많은 줄(어시스턴트의 스킨 줄: 고르기 + 단추 여섯)도
 * 줄을 넘쳐 가로 스크롤을 만들거나 이름·설명 칸을 0 폭으로 짓누르지 않는다. 조작은 줄바꿈하고, 이름 칸은 최소 폭을 지킨다.
 */
const rules = parseRules(readFileSync('src/styles/dialogs.css', 'utf-8'));
const decl = (selector: string, prop: string) =>
  rules
    .filter((r) => !r.atRule && r.selectors.includes(selector))
    .flatMap((r) => declarations(r.body))
    .filter((d) => d.prop === prop)
    .map((d) => d.value);

describe('settings rows', () => {
  it('a sub-row (the custom context window) spans the field and keeps its input at the end (visual QA)', () => {
    expect(decl('.settings-page .integration-field > .integration-field-sub', 'grid-column')).toEqual(['1 / -1']);
    expect(decl('.integration-field-sub', 'justify-content')).toEqual(['space-between']);
  });

  it('the control group wraps and may shrink, aligned to the end', () => {
    expect(decl('.setting-control', 'flex-wrap')).toEqual(['wrap']);
    expect(decl('.setting-control', 'flex')).toEqual(['0 1 auto']);
    expect(decl('.setting-control', 'justify-content')).toEqual(['flex-end']);
  });

  it('the skin buttons form an even grid of three columns (3+3), not ragged wrapped rows (visual QA)', () => {
    expect(decl('.setting-skin-actions', 'display')).toEqual(['grid']);
    expect(decl('.setting-skin-actions', 'grid-template-columns')).toEqual(['repeat(3, auto)']);
  });

  it('a text field shrinks with its control instead of pushing the row out of the pane (ko-dark web search, ~13px)', () => {
    expect(decl('.setting-control', 'min-width')).toEqual(['0']);
    expect(decl('.setting-text', 'max-width')).toEqual(['100%']);
  });

  it('the name and description keep a readable minimum width', () => {
    // 16rem: the skin row's buttons wrap instead of squeezing the description to ~190 px (Visual QA)
    expect(decl('.setting-info', 'flex')).toEqual(['1 1 16rem']);
    expect(decl('.setting-info', 'min-width')).toEqual(['min(16rem, 100%)']);
  });

  it('Korean descriptions do not break inside words; a count can sit on its own line', () => {
    expect(decl('.setting-desc', 'word-break')).toEqual(['keep-all']);
    expect(decl('.setting-desc', 'overflow-wrap')).toEqual(['anywhere']);
    expect(decl('.setting-desc-line', 'display')).toEqual(['block']);
  });
});
