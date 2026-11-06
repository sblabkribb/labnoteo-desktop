// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirstRun } from '../onboarding/FirstRun';
import { NewNote } from '../tree/NewNote';
import { NoteTree } from '../tree/NoteTree';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

/**
 * app.css 를 실제 마크업에 대어 본다. jsdom 의 getComputedStyle 은 선택자 특이도를 따지지 않아서(문서 순서만 본다)
 * 이긴 선언을 직접 고른다: 특이도, 같으면 뒤에 오는 것. "이 요소의 글자색은 무엇인가" 를 묻는 테스트용 작은 계단식이다.
 */
const css = readFileSync('src/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }))
  .filter((r) => !r.selectors[0].startsWith('@'));

function specificity(selector: string): [number, number, number] {
  let [a, b, c] = [0, 0, 0];
  let s = selector.replace(/:(?:not|has|is)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, arg: string) => {
    const [x, y, z] = specificity(arg);
    a += x; b += y; c += z;
    return '';
  });
  s = s.replace(/\[[^\]]*\]/g, () => (b++, ''));
  s = s.replace(/::[\w-]+/g, () => (c++, ''));
  s = s.replace(/:[\w-]+/g, () => (b++, ''));
  s = s.replace(/#[\w-]+/g, () => (a++, ''));
  s = s.replace(/\.[\w-]+/g, () => (b++, ''));
  s = s.replace(/(^|[\s>+~])([a-z][\w-]*)/gi, (_m, p: string) => (c++, p));
  return [a, b, c];
}
const higher = (x: number[], y: number[]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** 요소에 직접 선언돼 이긴 값. (상속은 보지 않는다: 직접 이겨야 하는 속성을 묻는 용도.) */
function winning(el: Element, prop: string): string | undefined {
  let best: { spec: number[]; value: string } | undefined;
  for (const r of rules) {
    const decl = new RegExp(String.raw`(?:^|;)\s*${prop}\s*:\s*([^;]+)`).exec(r.body);
    if (!decl) continue;
    for (const sel of r.selectors) {
      let hit = false;
      try {
        hit = el.matches(sel);
      } catch {
        hit = false; // 이 jsdom 이 못 읽는 선택자(:has 등)
      }
      if (!hit) continue;
      const spec = specificity(sel);
      if (!best || higher(spec, best.spec) >= 0) best = { spec, value: decl[1].trim() };
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
    const hover = rules.filter((r) => r.selectors.includes('.sidebar nav li > button[aria-current="true"]:hover:not(:disabled)'));
    expect(hover.length).toBe(1);
    expect(hover[0].body).not.toMatch(/box-shadow/);
  });
});
