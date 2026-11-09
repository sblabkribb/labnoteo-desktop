// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirstRun } from '../onboarding/FirstRun';
import { NewNoteForm } from '../tree/NewNote';
import { NoteTree } from '../tree/NoteTree';

import { allCss, compareSpecificity, declarations, parseRules, specificity, type Rule } from './css';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

/**
 * 앱 스타일(styles/*.css, 불러오는 순서대로 이은 것)을 실제 마크업에 대어 보는 작은 계단식. jsdom 의 getComputedStyle 은 선택자 특이도를 따지지 않아서(문서 순서만 본다)
 * 이긴 선언을 직접 고른다: 특이도가 높은 것, 같으면 뒤에 오는 것.
 *
 * 이것이 답하는 것은 정확히 "이 요소에 직접 선언된 값 가운데, 미디어 쿼리 밖에서, !important 없이, 상속 없이 이긴 값" 이다.
 * - 상속은 보지 않는다: 요소 자신에게 선언돼 이겨야 하는 속성을 묻는 용도다. 맞는 규칙이 없으면 undefined.
 * - @media 등 @-규칙 안의 규칙이 이 요소에 맞고 묻는 속성을 선언하면 던진다: 조건부 값을 무조건 값으로 셈하지 않고, 답할 수 없다고 말한다.
 *   (@-규칙 안 규칙이 맞더라도 다른 속성만 선언하면 상관없다.)
 * - 맞는 규칙의 그 속성 선언 중 하나라도 !important 면 던진다(순서와 상관없이): 이 계단식은 중요도 단계를 모른다.
 * - :hover 같은 상태는 jsdom 에서 맞지 않고, jsdom 이 못 읽는 선택자(:has 등)는 맞지 않은 것으로 친다.
 * - 한 규칙 안에 같은 속성이 두 번이면 뒤의 것이 이긴다. 단축 속성과 하위 속성(background 와 background-color)은 서로 다른 속성으로 본다.
 */
const APP_RULES = parseRules(allCss());

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
      if (decls.some((d) => d.important)) throw new Error(`!important 선언이 맞는다: ${sel} { ${prop} } — 이 계단식은 중요도를 모른다`);
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

  it('중첩된 CSS(규칙 안의 규칙)는 조용히 잘못 읽지 않고 던진다', () => {
    expect(() => parseRules('.a { color: var(--x); .b { color: var(--y); } }')).toThrow(/중첩/);
    expect(() => parseRules('.a { &:hover { color: var(--y); } }')).toThrow(/중첩/);
    // @-규칙 안의 규칙과 @keyframes 의 단계는 중첩이 아니다
    expect(parseRules('@media (x) { .a { color: var(--x); } } @keyframes k { 50% { opacity: 0; } }').map((r) => r.atRule)).toEqual(['@media (x)', '@keyframes k']);
  });

  it('!important 선언이 맞으면 던진다', () => {
    document.body.innerHTML = '<p>x</p>';
    expect(() => winning(document.querySelector('p')!, 'color', parseRules('p { color: var(--a) !important; }'))).toThrow(/important/);
    // 같은 규칙 안에서 !important 선언 뒤에 보통 선언이 와도(뒤의 것만 보면 놓친다) 던진다: 실제로는 !important 쪽이 이긴다
    expect(() => winning(document.querySelector('p')!, 'color', parseRules('p { color: var(--a) !important; color: var(--b); }'))).toThrow(/important/);
    expect(() => winning(document.querySelector('p')!, 'color', parseRules('p { color: var(--b); color: var(--a) !important; }'))).toThrow(/important/);
  });

  it('styles/*.css 의 @media 안 규칙을 @-규칙 안의 것으로 읽는다 (예전 정규식은 머리를 못 잡아 무조건 규칙으로 셌다)', () => {
    const heads = APP_RULES.filter((r) => r.atRule).map((r) => r.atRule);
    expect(heads).toContain('@media (max-width: 819.98px)');
    expect(heads).toContain('@media (prefers-color-scheme: dark)');
    expect(APP_RULES.find((r) => r.selectors.includes('.shell') && r.atRule)).toBeDefined();
    expect(APP_RULES.filter((r) => !r.atRule).length).toBeGreaterThan(50);
  });
});

describe('경고 글자색은 둘러싼 규칙에 지지 않는다', () => {
  it('첫 실행 화면의 오류는 위험색이다', () => {
    render(
      <main className="standalone">
        <FirstRun error="vault.error.generic" onOpen={() => {}} onCreate={() => {}} />
      </main>,
    );
    expect(winning(screen.getByRole('alert'), 'color')).toBe('var(--danger)');
  });

  it('새 노트 대화상자의 오류는 위험색이다', async () => {
    render(
      <div className="dialog">
        <NewNoteForm flush={async () => true} onCreated={() => {}} onCancel={() => {}} invoke={(async () => false) as never} />
      </div>,
    );
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
  it('보관함 맨 위(깊이 0)의 열린 노트도 막대가 보인다: 막대는 줄(treeitem)에 그린다', () => {
    render(
      <aside className="sidebar">
        <NoteTree entries={[{ path: 'a.labnote.md', name: 'a', isDir: false, depth: 0 }]} selected="a.labnote.md" onSelect={() => {}} />
      </aside>,
    );
    const row = screen.getByRole('treeitem', { name: 'a' });
    expect(row.getAttribute('data-depth')).toBe('0'); // 깊이 0 은 들여쓰기 규칙이 없다
    expect(winning(row, 'box-shadow')).toBe('inset 3px 0 0 var(--accent)');
    expect(winning(row, 'background')).toBe('var(--bg-selected)');
  });

  it('열린 줄의 hover 규칙은 막대(box-shadow)를 건드리지 않는다', () => {
    const hover = APP_RULES.filter((r) => r.selectors.includes('.note-tree [role="treeitem"][aria-current="true"]:hover'));
    expect(hover.length).toBe(1);
    expect(hover[0].body).not.toMatch(/box-shadow/);
  });
});

describe('단추는 평평하다: 보조는 회색 채움, 주된 것은 강조 채움, 테두리 없음', () => {
  /** 컨테이너 선택자를 실제 마크업으로 세운다. 그 안에 보통 단추와 주된 단추를 하나씩 둔다. */
  const MARKUP: Record<string, string> = {
    '.dialog': '<div class="dialog"><button>a</button><button class="primary">b</button></div>',
    '.first-run': '<div class="first-run"><button>a</button><button class="primary">b</button></div>',
    '.notices > aside': '<div class="notices"><aside><button>a</button><button class="primary">b</button></aside></div>',
  };

  it.each(['.dialog', '.first-run', '.notices > aside'])('%s: plain button is --bg-hover, primary is --accent-fill', (c) => {
    document.body.innerHTML = MARKUP[c];
    const plain = document.querySelector(`${c} button:not(.primary)`)!;
    const primary = document.querySelector(`${c} button.primary`)!;
    expect(winning(plain, 'background')).toBe('var(--bg-hover)');
    expect(winning(plain, 'border')).toBe('0');
    expect(winning(plain, 'min-height')).toBe('28px');
    expect(winning(primary, 'background')).toBe('var(--accent-fill)');
    expect(winning(primary, 'color')).toBe('var(--accent-text)');
  });

  it('.btn 클래스도 같은 모양이고, ghost 는 투명, ibtn 은 테두리 없는 아이콘 단추다', () => {
    document.body.innerHTML = '<span class="btn">a</span><span class="btn primary">b</span><span class="btn ghost">c</span><span class="ibtn">d</span>';
    expect(winning(document.querySelector('.btn:not(.primary):not(.ghost)')!, 'background')).toBe('var(--bg-hover)');
    expect(winning(document.querySelector('.btn.primary')!, 'background')).toBe('var(--accent-fill)');
    expect(winning(document.querySelector('.btn.ghost')!, 'background')).toBe('transparent');
    const ibtn = document.querySelector('.ibtn')!;
    expect(winning(ibtn, 'background')).toBe('transparent');
    expect(winning(ibtn, 'border')).toBe('0');
    expect(winning(ibtn, 'color')).toBe('var(--text-muted)');
  });

  it('입력은 28px, --bg 바탕, 1px --border 테두리다 (예전 진한 #8a8a94 테두리 없음); 체크박스는 높이를 받지 않는다', () => {
    document.body.innerHTML = '<input type="text"><select></select><input type="checkbox"><textarea></textarea>';
    const text = document.querySelector('input[type="text"]')!;
    expect(winning(text, 'border')).toBe('1px solid var(--border)');
    expect(winning(text, 'background')).toBe('var(--bg)');
    expect(winning(text, 'min-height')).toBe('28px');
    expect(winning(document.querySelector('select')!, 'min-height')).toBe('28px');
    expect(winning(document.querySelector('input[type="checkbox"]')!, 'min-height')).toBeUndefined();
    expect(winning(document.querySelector('textarea')!, 'min-height')).toBeUndefined();
  });

  it('--button-bg 되돌리기 장치는 없다', () => {
    expect(allCss()).not.toContain('--button-bg');
  });

  it('검색 결과 단추는 줄처럼 투명하고 hover 에만 채운다', () => {
    document.body.innerHTML = '<ul class="plain-list search-results"><li><button>x</button></li></ul>';
    expect(winning(document.querySelector('button')!, 'background')).toBe('transparent');
  });

  it('alert inside .sidebar-panel > section stays danger', () => {
    document.body.innerHTML = '<div class="sidebar-panel"><section><p>hint</p><p role="alert">err</p></section></div>';
    expect(winning(document.querySelector('.sidebar-panel > section > p[role="alert"]')!, 'color')).toBe('var(--danger)');
    expect(winning(document.querySelector('.sidebar-panel > section > p:not([role])')!, 'color')).toBe('var(--text-muted)');
  });

  it('컨테이너 글자 기본값은 :where() 로 특이도 0 이라 경고 규칙을 :not([role]) 없이도 이기지 못한다', () => {
    const sels = APP_RULES.flatMap((r) => r.selectors);
    for (const s of ['.first-run > p:not([role])', '.topbar form p:not([role])', ':where(.topbar form) p', '.sidebar-panel > section > p[role="alert"]']) {
      expect(sels, s).not.toContain(s);
    }
    expect(sels).toContain(':where(.first-run) p');
    expect(sels).toContain(':where(.sidebar-panel > section) p');
    // 컨테이너마다 따로 두던 주된 단추 배경 되돌리기는 없다
    expect(sels.filter((s) => /\S+ button\.primary$/.test(s))).toEqual([]);
  });
});
