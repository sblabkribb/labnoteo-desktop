// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirstRun } from '../onboarding/FirstRun';
import { NewNote } from '../tree/NewNote';
import { NoteTree } from '../tree/NoteTree';

import { compareSpecificity, declarations, parseRules, specificity, type Rule } from './css';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

/**
 * app.css 를 실제 마크업에 대어 보는 작은 계단식. jsdom 의 getComputedStyle 은 선택자 특이도를 따지지 않아서(문서 순서만 본다)
 * 이긴 선언을 직접 고른다: 특이도가 높은 것, 같으면 뒤에 오는 것.
 *
 * 이것이 답하는 것은 정확히 "이 요소에 직접 선언된 값 가운데, 미디어 쿼리 밖에서, !important 없이, 상속 없이 이긴 값" 이다.
 * - 상속은 보지 않는다: 요소 자신에게 선언돼 이겨야 하는 속성을 묻는 용도다. 맞는 규칙이 없으면 undefined.
 * - @media 등 @-규칙 안의 규칙이 이 요소에 맞고 묻는 속성을 선언하면 던진다: 조건부 값을 무조건 값으로 셈하지 않고, 답할 수 없다고 말한다.
 *   (@-규칙 안 규칙이 맞더라도 다른 속성만 선언하면 상관없다.)
 * - 맞는 선언에 !important 가 있으면 던진다: 이 계단식은 중요도 단계를 모른다.
 * - :hover 같은 상태는 jsdom 에서 맞지 않고, jsdom 이 못 읽는 선택자(:has 등)는 맞지 않은 것으로 친다.
 * - 한 규칙 안에 같은 속성이 두 번이면 뒤의 것이 이긴다. 단축 속성과 하위 속성(background 와 background-color)은 서로 다른 속성으로 본다.
 */
const APP_RULES = parseRules(readFileSync('src/app.css', 'utf-8'));

function winning(el: Element, prop: string, rules: Rule[] = APP_RULES): string | undefined {
  let best: { spec: number[]; value: string } | undefined;
  for (const r of rules) {
    const decls = declarations(r.body).filter((d) => d.prop === prop);
    if (decls.length === 0) continue;
    const decl = decls[decls.length - 1];
    for (const sel of r.selectors) {
      let hit = false;
      try {
        hit = el.matches(sel);
      } catch {
        hit = false; // 이 jsdom 이 못 읽는 선택자(:has 등)
      }
      if (!hit) continue;
      if (r.atRule) throw new Error(`${r.atRule} 안의 규칙이 맞는다: ${sel} { ${prop} } — 이 계단식은 조건부 값을 답하지 않는다`);
      if (decl.important) throw new Error(`!important 선언이 맞는다: ${sel} { ${prop} } — 이 계단식은 중요도를 모른다`);
      const spec = specificity(sel);
      if (!best || compareSpecificity(spec, best.spec) >= 0) best = { spec, value: decl.value };
    }
  }
  return best?.value;
}

afterEach(() => {
  document.body.innerHTML = ''; // 손으로 넣은 마크업이 다음 테스트의 질의에 섞이지 않게
});

describe('계단식 자기 점검', () => {
  it('특이도 계산과 이긴 선언 고르기가 맞다', () => {
    expect(specificity('.a > p')).toEqual([0, 1, 1]);
    expect(specificity('[role="alert"]')).toEqual([0, 1, 0]);
    expect(specificity('.topbar form p:not([role])')).toEqual([0, 2, 2]);
    expect(specificity('.sidebar nav li:has(> button[aria-current="true"]):hover')).toEqual([0, 3, 3]);
    document.body.innerHTML = '<div class="first-run"><p>hint</p><p role="alert">err</p></div>';
    expect(winning(document.querySelector('p')!, 'color')).toBe('var(--text-muted)');
  });

  it('특이도가 높은 색 규칙이 순서와 상관없이 이긴다', () => {
    document.body.innerHTML = '<div class="box"><p class="note">x</p></div>';
    const p = document.querySelector('p')!;
    expect(winning(p, 'color', parseRules('.box .note { color: var(--a); } .note { color: var(--b); }'))).toBe('var(--a)');
    expect(winning(p, 'color', parseRules('.note { color: var(--b); } .box .note { color: var(--a); }'))).toBe('var(--a)');
  });

  it('특이도가 같으면 뒤에 오는 색 규칙이 이긴다', () => {
    document.body.innerHTML = '<p class="note" role="alert">x</p>';
    const p = document.querySelector('p')!;
    expect(winning(p, 'color', parseRules('.note { color: var(--a); } [role="alert"] { color: var(--b); }'))).toBe('var(--b)');
    expect(winning(p, 'color', parseRules('[role="alert"] { color: var(--b); } .note { color: var(--a); }'))).toBe('var(--a)');
    // 한 규칙 안에서 같은 속성을 두 번 쓰면 뒤의 것
    expect(winning(p, 'color', parseRules('.note { color: var(--a); color: var(--b); }'))).toBe('var(--b)');
  });

  it('@media 안의 규칙은 이기지 못한다: 맞고 그 속성을 선언하면 답하지 않고 던진다', () => {
    document.body.innerHTML = '<p role="alert">x</p>';
    const p = document.querySelector('p')!;
    // 바깥 규칙보다 특이도가 높고 뒤에 있어도 무조건 값으로 세지 않는다
    const conditional = parseRules('p { color: var(--a); } @media (prefers-color-scheme: dark) { p[role="alert"] { color: var(--b); } }');
    expect(() => winning(p, 'color', conditional)).toThrow(/@media \(prefers-color-scheme: dark\)/);
    // @media 안의 규칙이 맞아도 다른 속성만 선언하면 상관없다
    expect(winning(p, 'color', parseRules('p { color: var(--a); } @media (max-width: 640px) { p { margin: 0; } }'))).toBe('var(--a)');
    // 맞지 않는 @media 규칙도 상관없다
    expect(winning(p, 'color', parseRules('p { color: var(--a); } @media (max-width: 640px) { .shell { color: var(--b); } }'))).toBe('var(--a)');
  });

  it('!important 선언이 맞으면 던진다', () => {
    document.body.innerHTML = '<p>x</p>';
    expect(() => winning(document.querySelector('p')!, 'color', parseRules('p { color: var(--a) !important; }'))).toThrow(/important/);
  });

  it('app.css 의 @media 안 규칙을 @-규칙 안의 것으로 읽는다 (예전 정규식은 머리를 못 잡아 무조건 규칙으로 셌다)', () => {
    const heads = APP_RULES.filter((r) => r.atRule).map((r) => r.atRule);
    expect(heads).toContain('@media (max-width: 640px)');
    expect(heads).toContain('@media (prefers-color-scheme: dark)');
    expect(APP_RULES.find((r) => r.selectors.includes('.shell') && r.atRule)).toBeDefined();
    expect(APP_RULES.filter((r) => !r.atRule).length).toBeGreaterThan(50);
  });
});

describe('경고 글자색은 둘러싼 규칙에 지지 않는다', () => {
  it('첫 실행 화면의 오류는 위험색이다', () => {
    render(
      <main className="standalone">
        <FirstRun error="열 수 없습니다" onOpen={() => {}} onCreate={() => {}} />
      </main>,
    );
    expect(winning(screen.getByRole('alert'), 'color')).toBe('var(--danger)');
  });

  it('상단 바의 새 노트 오류는 위험색이다', async () => {
    render(
      <header className="topbar">
        <NewNote flush={async () => true} onCreated={() => {}} invoke={(async () => false) as never} />
      </header>,
    );
    await userEvent.click(screen.getByRole('button', { name: '새 노트' }));
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    expect(winning(await screen.findByRole('alert'), 'color')).toBe('var(--danger)');
    // 같은 줄의 안내문은 여전히 흐리다 (경고만 빠진다)
    expect(winning(screen.getByText(/\.labnote\.md|보관함/, { selector: 'p:not([role])' }), 'color')).toBe('var(--text-muted)');
  });

  it('경고 안의 주된 단추는 자기 글자색(--accent-text)을 지킨다', () => {
    document.body.innerHTML = '<p role="alert">x <button class="primary">y</button> <button>z</button></p>';
    expect(winning(document.querySelector('button.primary')!, 'color')).toBe('var(--accent-text)');
    expect(winning(document.querySelector('button:not(.primary)')!, 'color')).toBe('var(--text)');
  });
});

describe('열린 노트의 강조 막대', () => {
  it('보관함 맨 위(깊이 0)의 열린 노트도 막대가 보인다: 막대는 줄이 아니라 줄을 덮는 단추에 그린다', () => {
    render(
      <aside className="sidebar">
        <NoteTree entries={[{ path: 'a.labnote.md', name: 'a', isDir: false, depth: 0 }]} selected="a.labnote.md" onSelect={() => {}} />
      </aside>,
    );
    const button = screen.getByRole('button', { name: 'a' });
    expect(button.closest('li')!.getAttribute('data-depth')).toBe('0'); // 깊이 0 은 들여쓰기 규칙이 없다: 단추가 줄을 다 덮는다
    expect(winning(button, 'box-shadow')).toBe('inset 3px 0 0 var(--accent)');
  });

  it('열린 줄의 hover 규칙은 막대(box-shadow)를 건드리지 않는다', () => {
    const hover = APP_RULES.filter((r) => r.selectors.includes('.sidebar nav li > button[aria-current="true"]:hover:not(:disabled)'));
    expect(hover.length).toBe(1);
    expect(hover[0].body).not.toMatch(/box-shadow/);
  });
});
