import { allCss, declarations, parseRules } from './css';
import { INDENT_CAP, MAX_DEPTH } from '../tree/depth';
import { editorThemeSpec } from '../editor/theme';

const css = allCss();

/** 선택자 목록에 `selector` 가 들어 있는 규칙의 선택자들과 본문. 없으면 null. */
function ruleFor(selector: string): { selectors: string[]; body: string; decls: Record<string, string> } | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) {
      const body = m[2];
      const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const decls = Object.fromEntries(declarations(clean.replace(/;\s*$/, '')).map((d) => [d.prop, d.value]));
      return { selectors, body, decls };
    }
  }
  return null;
}

describe('앱 셸 CSS 계약', () => {
  // 따옴표가 든 정규식은 String.raw 로 쓴다(escapes.test.ts 가 정규식 리터럴 안의 따옴표를 문자열의 시작으로 읽는다)
  const DEEP_DEPTH_RULE = new RegExp(String.raw`\.(sidebar|note-tree) .*data-depth="(9|1\d|2\d)"`);
  it('one depth rule per level up to MAX_DEPTH and a single deep cap', () => {
    for (let d = 1; d <= MAX_DEPTH; d++) expect(ruleFor(`[data-depth="${d}"]`)?.decls['padding-left'], `depth ${d}`).toBe(`calc(var(--indent) * ${d})`);
    expect(ruleFor(`[data-depth="${MAX_DEPTH + 1}"]`)).toBeNull();
    expect(parseRules(css).filter((r) => r.selectors.some((sel) => DEEP_DEPTH_RULE.test(sel)))).toEqual([]);
    expect(ruleFor('.sidebar .deep')!.decls['padding-left']).toBe(`calc(var(--indent) * ${INDENT_CAP})`);
  });

  it('print hides chrome', () => {
    const p = parseRules(css).filter((r) => r.atRule === '@media print').flatMap((r) => r.selectors).join(',');
    for (const s of ['.ribbon', '.sidebar', '.dock-scrim', '.statusbar', '.notices', '.toaster', '.dialog-layer', '.context-menu', '.view-header']) expect(p).toContain(s);
  });

  it('print drops the full-window grid and the content scroller', () => {
    const inPrint = (sel: string) => {
      const r = parseRules(css).find((x) => x.atRule === '@media print' && x.selectors.includes(sel));
      return r ? Object.fromEntries(declarations(r.body).map((d) => [d.prop, d.value])) : null;
    };
    expect(inPrint('.shell')).toMatchObject({ display: 'block', height: 'auto' });
    expect(inPrint('.content')).toMatchObject({ overflow: 'visible' });
  });

  it('print hides the table toolbar inside the editor shadow root', () => {
    const print = editorThemeSpec['@media print'] as Record<string, Record<string, string>>;
    expect(print['.lno-table-toolbar']?.display).toBe('none');
  });

  it('독의 탭은 아이콘 탭이다: 줄을 넘기지 않고, 고른 탭은 --bg-selected 채움만 받는다(알약·밑줄 없음)', () => {
    expect(ruleFor('.dock-tabs')!.decls['flex-wrap']).toBe('nowrap');
    const selected = ruleFor('.dock-tab[aria-selected="true"]')!;
    expect(selected.decls['background']).toBe('var(--bg-selected)');
    expect(selected.body).not.toMatch(/box-shadow|border-bottom|text-decoration/);
  });

  it('독의 너비와 숨김은 <html> 의 변수와 속성을 따르고, 끄는 동안은 전환을 끈다', () => {
    expect(ruleFor('.shell')!.decls['grid-template-columns']).toBe('var(--ribbon-w) var(--side-w) minmax(0, 1fr) auto');
    expect(ruleFor('.shell')!.decls['transition']).toBe('grid-template-columns var(--motion)');
    expect(ruleFor(':root[data-left-hidden="true"] .shell')!.decls['grid-template-columns']).toBe('var(--ribbon-w) 0 minmax(0, 1fr) auto');
    expect(ruleFor(':root[data-left-hidden="true"] .dock')!.decls['display']).toBe('none');
    expect(ruleFor(':root[data-resizing] .shell')!.decls['transition']).toBe('none');
    // 좁은 창에서는 독이 떠서 열리고 깔개가 깔린다
    const narrow = parseRules(css).filter((r) => r.atRule === '@media (max-width: 819.98px)');
    expect(narrow.find((r) => r.selectors.includes('.dock'))!.body).toMatch(/position:\s*fixed/);
    expect(narrow.find((r) => r.selectors.includes('.dock-scrim'))!.body).toMatch(/background:\s*var\(--scrim\)/);
  });

  it('긴 노트 이름은 사이드바를 밀지 않고 말줄임된다', () => {
    const row = ruleFor('.note-tree [role="treeitem"]');
    expect(row).not.toBeNull();
    expect(row!.body).toMatch(/overflow:\s*hidden/);
    expect(row!.body).toMatch(/text-overflow:\s*ellipsis/);
    expect(row!.body).toMatch(/white-space:\s*nowrap/);
    expect(row!.body).toMatch(/min-width:\s*0/);
    expect(ruleFor('.sidebar')!.body).toMatch(/overflow-x:\s*hidden/);
  });

  it('열린 노트는 회색 채움만 받는다: 강조 막대는 없다 (spec 4.1)', () => {
    const rule = ruleFor('.note-tree [role="treeitem"][aria-current="true"]');
    expect(rule).not.toBeNull();
    expect(rule!.decls['background']).toBe('var(--bg-selected)');
    expect(rule!.body).not.toMatch(/box-shadow/);
    expect(ruleFor('.wf-tree-row[aria-current="true"]')!.body).not.toMatch(/box-shadow/);
  });

  it('tree rows sit on --row-h with a small radius; folders are regular weight', () => {
    const row = ruleFor('.wf-tree-row')!;
    expect(row.decls['min-height']).toBe('var(--row-h)');
    expect(row.decls['border-radius']).toBe('var(--radius-s)');
    expect(parseRules(css).filter((r) => r.selectors.some((sel) => sel.startsWith('.wf-tree-row[aria-expanded]')) && /font-weight/.test(r.body))).toEqual([]);
    expect(ruleFor(':root[data-density="compact"]')!.decls['--row-h']).toBe('24px');
  });

  it('indent guides are drawn per depth and show only while the dock is hovered or focused', () => {
    for (let d = 1; d <= MAX_DEPTH; d++) expect(ruleFor(`[data-depth="${d}"]`)!.decls['--depth'], `depth ${d}`).toBe(String(d));
    expect(ruleFor('.sidebar .deep')!.decls['--depth']).toBe(String(INDENT_CAP));
    const guide = ruleFor('.wf-tree-row::before')!;
    expect(guide.decls['width']).toBe('calc(var(--indent) * var(--depth, 0))');
    expect(guide.body).toMatch(/var\(--guide\)/);
    expect(guide.decls['opacity']).toBe('0');
    const shown = ruleFor('.dock:hover .wf-tree-row::before')!;
    expect(shown.selectors).toContain('.dock:focus-within .wf-tree-row::before');
    expect(shown.decls['opacity']).toBe('1');
  });

  it('트리 줄은 단추가 아니라 treeitem 이고, 테두리가 없다 (--border-strong 은 선택 배경에서 2.43:1)', () => {
    const row = ruleFor('.note-tree [role="treeitem"]')!;
    expect(row.body).not.toMatch(/border/);
    expect(ruleFor('.wf-tree-row')!.body).not.toMatch(/border(?!-radius)/);
    expect(parseRules(css).flatMap((r) => r.selectors).filter((sel) => sel.includes('.note-tree') && /button|li\b/.test(sel))).toEqual([]);
  });

  it('사이드바의 탭 패널과 본문이 각자 스크롤한다(탭 줄과 보관함 줄은 남는다)', () => {
    expect(ruleFor('.sidebar')!.body).toMatch(/overflow-y:\s*hidden/);
    expect(ruleFor('.sidebar-panel')!.body).toMatch(/overflow-y:\s*auto/);
    expect(ruleFor('.content')!.body).toMatch(/overflow:\s*auto/);
  });

  it('주된 동작 단추는 상단 바 hover 에서도 강조색이다 (hover 에 --accent-text 글자가 --bg-hover 위에 놓이지 않게)', () => {
    // 영역별 hover 규칙은 없다: 전역 button:hover 와, 그보다 특이도가 높은 button.primary:hover 가 정한다
    expect(ruleFor('.topbar button:hover:not(:disabled)')).toBeNull();
    expect(ruleFor('.topbar button:not(.primary):hover:not(:disabled)')).toBeNull();
    expect(ruleFor('button:hover:not(:disabled)')!.body).toMatch(/background:\s*var\(--btn-bg-hover\)/);
    expect(ruleFor('button.primary:hover:not(:disabled)')!.body).toMatch(/background:\s*var\(--accent-fill-hover\)/);
  });

  it('열린 줄의 색조는 :has() 없이 걸리고, 열린 줄도 hover 에 반응한다', () => {
    expect(ruleFor('.note-tree [role="treeitem"][aria-current="true"]')!.body).toMatch(/background:\s*var\(--bg-selected\)/);
    const hover = ruleFor('.note-tree [role="treeitem"][aria-current="true"]:hover');
    expect(hover!.body).toMatch(/background:\s*var\(--bg-selection\)/);
    expect(hover!.selectors).toEqual(['.note-tree [role="treeitem"][aria-current="true"]:hover']);
    // 줄이 곧 대상이라 :has() 로 부모를 칠할 일이 없다
    expect(parseRules(css).flatMap((r) => r.selectors).filter((sel) => sel.includes('.note-tree') && sel.includes(':has('))).toEqual([]);
  });

  it('chevrons are Lucide icons that turn when open, not ::before glyphs', () => {
    expect(ruleFor('.wf-tree-row[aria-expanded]::before')).toBeNull();
    expect(ruleFor('.wf-tree-row[aria-expanded="true"] > .tree-chevron svg')!.decls['transform']).toBe('rotate(90deg)');
    expect(ruleFor('.tree-chevron svg')!.decls['color']).toBe('var(--text-faint)');
  });
  it('shell regions are styled through class hooks, not child chains', () => {
    const sels = parseRules(css).flatMap((r) => r.selectors);
    expect(sels.some((s) => /\.content\s*>\s*section/.test(s))).toBe(false);
    expect(sels.some((s) => /\.sidebar (nav|section) li/.test(s))).toBe(false);
    expect(ruleFor('.note-tree [role="treeitem"]')).not.toBeNull();
    expect(ruleFor('.search-results li > button')).not.toBeNull();
    expect(ruleFor('.view-header')).not.toBeNull();
    expect(ruleFor('.editor-frame')).not.toBeNull();
    expect(sels.some((s) => s.includes('.content [role="alertdialog"]'))).toBe(false);
  });
  it('view header: no rules left for the removed Workflow done chip or the Insert table label', () => {
    const sels = parseRules(css).flatMap((r) => r.selectors);
    expect(sels.filter((s) => /\.wf-done\b/.test(s))).toEqual([]);
    expect(sels.filter((s) => s.includes('.view-header-actions .btn-label-collapsible'))).toEqual([]);
    // 좁은 창에서 이름을 숨기는 것은 상태 칩뿐이다
    expect(sels).toContain('.view-header-lead .chip.status .btn-label-collapsible');
  });
  it('layers use the z-index scale', () => {
    expect(ruleFor('.dialog-layer')!.decls['z-index']).toBe('var(--z-dialog)');
    expect(ruleFor('.context-menu')!.decls['z-index']).toBe('var(--z-menu)');
    expect(ruleFor('.toaster')!.decls['z-index']).toBe('var(--z-toast)');
    expect(ruleFor('.dialog-backdrop')!.decls.background).toBe('var(--scrim)');
  });
  it('editor frame: no frame and no focus ring around the document (Obsidian, spec §3 and §5.7)', () => {
    expect(ruleFor('.editor-frame')!.decls.border).toBe('none');
    expect(ruleFor('.editor-frame:focus-within')!.decls.outline).toBe('none');
    expect(ruleFor('.editor-frame')!.decls.isolation).toBe('isolate');
  });

  it('GitHub 창의 본문은 창 높이(76vh) 안에서 스크롤한다: 찾은 것이 많아도 단추가 창 밖으로 나가지 않는다', () => {
    expect(ruleFor('.dialog')!.decls['max-height']).toBe('76vh');
    const body = ruleFor('.dialog.github-dialog .github-form')!;
    expect(body.decls['min-height']).toBe('0');
    expect(body.decls['overflow-y']).toBe('auto');
    // 파일 목록은 줄어들지 않는다: 찾은 것이 많으면 목록이 0px 로 눌리지 않고 본문이 스크롤한다
    expect(ruleFor('.github-files')!.decls.flex).toBe('none');
    // 스크롤은 본문 하나만: 목록이 따로 스크롤하면 스크롤 막대가 둘 겹치고 마지막 묶음이 legend 에서 잘린다(visual QA)
    expect(ruleFor('.github-files')!.decls['max-height']).toBeUndefined();
    expect(ruleFor('.github-files')!.decls.overflow).toBeUndefined();
    // 고칠 것이 있는 파일은 목록에서 눈에 띈다
    expect(ruleFor('.github-file.flagged')!.decls.color).toBe('var(--danger)');
    expect(ruleFor('.github-badge.fix')!.decls.color).toBe('var(--danger)');
  });
});
