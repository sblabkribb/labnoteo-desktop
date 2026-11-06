import { readFileSync } from 'node:fs';

const css = readFileSync('src/app.css', 'utf-8');

/** 선택자 목록에 `selector` 가 들어 있는 규칙의 선택자들과 본문. 없으면 null. */
function ruleFor(selector: string): { selectors: string[]; body: string } | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return { selectors, body: m[2] };
  }
  return null;
}

describe('앱 셸 CSS 계약', () => {
  it('깊은 트리: 8단계보다 깊은 줄은 사이드바 안에서 8단계 들여쓰기로 고정된다', () => {
    const cap = ruleFor('.sidebar nav li[data-depth="24"]');
    expect(cap).not.toBeNull();
    expect(cap!.body).toMatch(/padding-left:\s*calc\(var\(--indent\) \* 8\)/);
    for (let d = 9; d <= 24; d++) expect(cap!.selectors, `depth ${d}`).toContain(`.sidebar nav li[data-depth="${d}"]`);
    for (let d = 1; d <= 8; d++) expect(cap!.selectors, `depth ${d}`).not.toContain(`.sidebar nav li[data-depth="${d}"]`);
  });

  it('긴 노트 이름은 사이드바를 밀지 않고 말줄임된다', () => {
    const row = ruleFor('.sidebar nav li > button');
    expect(row).not.toBeNull();
    expect(row!.body).toMatch(/overflow:\s*hidden/);
    expect(row!.body).toMatch(/text-overflow:\s*ellipsis/);
    expect(row!.body).toMatch(/white-space:\s*nowrap/);
    expect(row!.body).toMatch(/min-width:\s*0/);
    expect(ruleFor('.sidebar')!.body).toMatch(/overflow-x:\s*hidden/);
  });

  it('열린 노트는 색조 말고 모양(왼쪽 3px 강조 막대)으로도 드러난다', () => {
    // 막대는 줄을 덮는 단추에 그린다: li 에 그리면 불투명한 단추 배경이 가린다 (깊이 0 의 열린 노트).
    const rule = ruleFor('.sidebar nav li > button[aria-current="true"]');
    expect(rule).not.toBeNull();
    expect(rule!.body).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--accent\)/);
    expect(ruleFor('.sidebar nav li:has(> button[aria-current="true"])')!.body).not.toMatch(/box-shadow/);
  });

  it('트리 줄 안의 단추에는 테두리가 없다 (--border-strong 은 선택 배경에서 2.43:1)', () => {
    const row = ruleFor('.sidebar nav li > button')!;
    expect(row.body).toMatch(/border:\s*0/);
    expect(row.body).not.toMatch(/border-strong/);
  });

  it('사이드바와 본문이 각자 스크롤한다', () => {
    expect(ruleFor('.sidebar')!.body).toMatch(/overflow-y:\s*auto/);
    expect(ruleFor('.content')!.body).toMatch(/overflow:\s*auto/);
  });

  it('주된 동작 단추는 상단 바 hover 규칙에서 빠진다 (hover 에 --accent-text 글자가 --bg-hover 위에 놓이지 않게)', () => {
    expect(ruleFor('.topbar button:hover:not(:disabled)')).toBeNull();
    expect(ruleFor('.topbar button:not(.primary):hover:not(:disabled)')).not.toBeNull();
  });

  it('열린 줄의 색조는 :has() 없이도 걸리고, 열린 줄도 hover 에 반응한다', () => {
    expect(ruleFor('.sidebar nav li > button[aria-current="true"]')!.body).toMatch(/background:\s*var\(--bg-selected\)/);
    const hover = ruleFor('.sidebar nav li > button[aria-current="true"]:hover:not(:disabled)');
    expect(hover!.body).toMatch(/background:\s*var\(--bg-selection\)/);
    // :has() 를 못 읽는 환경은 그것이 든 선택자 목록 전체를 버린다: :has() 규칙과 한 목록으로 묶지 않는다.
    expect(hover!.selectors).toEqual(['.sidebar nav li > button[aria-current="true"]:hover:not(:disabled)']);
    const hasHover = ruleFor('.sidebar nav li:has(> button[aria-current="true"]):hover');
    expect(hasHover).not.toBeNull();
    expect(hasHover!.selectors).toEqual(['.sidebar nav li:has(> button[aria-current="true"]):hover']);
    expect(hasHover!.body).toMatch(/background:\s*var\(--bg-selection\)/);
  });

  it('접기 표시는 대체 텍스트 문법을 못 읽어도 남는다 (content 선언이 둘)', () => {
    const open = ruleFor('.sidebar nav li > button[aria-expanded]::before')!.body;
    expect(open).toMatch(/content:\s*"▾";/);
    expect(open).toMatch(/content:\s*"▾" \/ "";/);
  });
});
