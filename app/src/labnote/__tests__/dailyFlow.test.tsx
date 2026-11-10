// @vitest-environment jsdom
/**
 * 하루의 실험 노트 흐름을 앱 전체(App)로 끝까지 돌린다. 파일은 fakeVault, 대화상자의 답은 대화상자 저장소로 준다.
 * 실험 만들기(Ctrl+P) → README 에 입력(자동 저장 전) → Workflows 패널에서 카탈로그 워크플로 만들기 → 머리 단추로
 * 단위 공정 넣기(되돌리기 한 번) → Meta End_date 에 날짜와 시간 → 상태를 failed 로 → 다시 하기.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { redo, undo, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { copyFrontMatterKeys, setFrontMatterKeys } from '@labnoteo/core';
import { createLabnoteStructure, retryOfLink, setRetryOf } from '@labnoteo/core/lib/labnoteStructure';
import { createWorkflowFileName, insertWorkflowChecklistEntries } from '@labnoteo/core/lib/workflowStructure';
import { App } from '../../App';
import { activeCellView, focusCell } from '../../editor/table/cellEditor';
import { installFakeVault, type FakeVault } from '../../__tests__/fakeVault';
import { setLang } from '../../i18n/lang';
import { readmeStamp } from '../commands/stamp';
import { clearCommandsForTest } from '../commands/registry';
import { closeAllDialogs, currentDialog, deepActiveElement, settleDialog, type DialogEntry, type DialogSpec } from '../host/dialogStore';
import { clearToasts, subscribeToasts, currentToasts, type Toast } from '../host/toastStore';
import { coreT, paletteName } from '../i18n';
import { fromPluginData } from '../settings';
import { closeMenu } from '../ui/menuStore';

vi.mock('@tauri-apps/api/core', async () => (await import('../../__tests__/fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('../../__tests__/fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('../../__tests__/fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다(editorHarness 와 같다).
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const TITLE = '형질전환 1차';
const DIR = 'labnote/001_형질전환_1차';
const README_PATH = `${DIR}/README.labnote.md`;
const RETRY_DIR = 'labnote/002_형질전환_2차';
const RETRY_README = `${RETRY_DIR}/README.labnote.md`;
const WF = { id: 'WB010', name: 'DNA Oligomer Assembly' };
const WF_FILE = createWorkflowFileName('001', { ...WF, description: '' }, 'pET');
const WF_PATH = `${DIR}/${WF_FILE}`;
const TYPED = '오늘 할 일: 형질전환 준비\n';
const OP = { id: 'UHW010', name: 'Liquid Handling' };
/** 날짜와 시간으로 채운 End_date 줄(따옴표 안의 날짜 시간). */
const FILLED_END_DATE = /- End_date: '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}'/;

/** 날짜와 시간은 실행하는 날에 따라 다르다: 비교할 때 가린다. */
const maskDates = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?/g, 'DATE');

/** `before` 의 줄이 모두 같은 순서로 `after` 에 남아 있으면 더한 줄을, 아니면 undefined 를 돌려준다. */
function addedLines(before: string, after: string): string[] | undefined {
  const a = before.split('\n');
  const added: string[] = [];
  let i = 0;
  for (const line of after.split('\n')) {
    if (i < a.length && line === a[i]) i++;
    else added.push(line);
  }
  return i === a.length ? added : undefined;
}

/** 지금 편집기에 열린 노트의 CodeMirror 뷰(그림자 루트 안). */
function currentView(): EditorView {
  const host = document.querySelector('main.content .editor-frame') as HTMLElement | null;
  const cm = host?.shadowRoot?.querySelector('.cm-editor') as HTMLElement | null;
  if (!cm) throw new Error('no editor');
  return EditorView.findFromDOM(cm)!;
}

/** 편집기가 `path` 를 열고 다 읽었다(바쁘지 않다). */
async function editorReady(path: string, contains?: string) {
  await waitFor(() => {
    expect(screen.getByRole('main').querySelector('section.editor-view')?.getAttribute('data-path')).toBe(path);
    const v = currentView();
    if (contains) expect(v.state.doc.toString()).toContain(contains);
  });
}

/**
 * 지금 보이는 대화상자가 `kind` 일 때까지 기다렸다가, `choose` 가 돌려준 값으로 끝낸다(사람이 답한 것과 같다).
 * 그동안 .shell 은 inert 이고 대화상자가 그려져 있다.
 */
async function answer<K extends DialogSpec['kind']>(kind: K, choose: (spec: Extract<DialogSpec, { kind: K }>) => unknown): Promise<Extract<DialogSpec, { kind: K }>> {
  let entry!: DialogEntry;
  await waitFor(() => {
    const d = currentDialog();
    expect(d?.spec.kind).toBe(kind);
    expect(document.querySelector('.shell')?.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    entry = d!;
  });
  const spec = entry.spec as Extract<DialogSpec, { kind: K }>;
  const value = choose(spec);
  await act(async () => settleDialog(entry.id, value));
  return spec;
}

/** 고르기에서 `label` 로 시작하는 항목의 값. */
const itemStarting =
  (label: string) =>
  (spec: Extract<DialogSpec, { kind: 'pick' }>): unknown => {
    const item = spec.items.find((i) => i.label.startsWith(label));
    expect(item, `no item starting with ${label}: ${spec.items.map((i) => i.label).join(', ')}`).toBeTruthy();
    return item!.value;
  };

/** Ctrl+P 로 팔레트를 열고 `nameKey` 명령을 고른다. */
async function palette(nameKey: string) {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'p', code: 'KeyP', ctrlKey: true });
  });
  await answer('pick', itemStarting(paletteName(nameKey)));
}

/** 띄운 알림을 모두 적는다(알림은 몇 초 뒤 사라지고 5개까지만 보인다). */
function recordToasts(): { all: Toast[]; stop: () => void } {
  const seen = new Map<number, Toast>();
  const take = () => currentToasts().forEach((x) => seen.set(x.id, x));
  const stop = subscribeToasts(take);
  return {
    get all() {
      return [...seen.values()];
    },
    stop,
  };
}

let vault: FakeVault;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  setLang('ko');
});

afterEach(() => {
  act(() => {
    closeAllDialogs();
    closeMenu();
  });
  clearToasts();
  clearCommandsForTest();
  vi.unstubAllGlobals();
});

describe('하루의 흐름(앱 전체)', () => {
  it(
    'create experiment, type, create workflow, insert unit op, date, fail, retry: files, checklist, TOC and Korean toasts',
    async () => {
      const user = userEvent.setup();
      vault = installFakeVault({});
      const toasts = recordToasts();
      render(<App />);
      await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
      const paletteButton = within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '명령 팔레트' }) as HTMLButtonElement;
      await waitFor(() => expect(paletteButton.disabled).toBe(false));

      // 1. Ctrl+P → "실험 생성" → 제목
      await palette('Create experiment');
      await answer('prompt', () => TITLE);

      // 2. README 가 열린다
      await editorReady(README_PATH, 'Related Workflows');
      expect(vault.files()[README_PATH]).toBeDefined();
      const created = vault.files()[README_PATH];

      // 3. README 에 한 줄 친다(자동 저장을 기다리지 않는다)
      await act(async () => {
        const v = currentView();
        v.dispatch({ changes: { from: v.state.doc.length, insert: TYPED }, userEvent: 'input.type' });
      });
      expect(vault.files()[README_PATH]).not.toContain(TYPED);

      // 4. Workflows 패널 → 카탈로그 워크플로 → 워크플로 생성, 별칭 "pET"
      await user.click(screen.getByRole('tab', { name: '실험' }));
      await user.click(await screen.findByRole('button', { name: /^카탈로그/ }));
      const catalog = await screen.findByRole('tree', { name: '카탈로그' });
      const root = await within(catalog).findByRole('treeitem', { name: /^워크플로/ });
      await user.click(root);
      let wfRow: HTMLElement | undefined;
      await waitFor(async () => {
        // 분류 묶음이 있으면 펼쳐 가며 WB010 을 찾는다
        for (const li of within(catalog).getAllByRole('treeitem')) {
          if (li.getAttribute('aria-expanded') === 'false' && li !== root) await user.click(li);
        }
        wfRow = within(catalog)
          .getAllByRole('treeitem')
          .find((li) => li.querySelector('.meta.code')?.textContent === WF.id);
        expect(wfRow).toBeTruthy();
      });
      // 카탈로그 항목의 작은 창: 열린 README 의 실험에 더한다
      await user.click(wfRow!);
      const pop = await screen.findByRole('dialog', { name: new RegExp(`^${WF.id} `) });
      await user.click(within(pop).getByRole('button', { name: /^현재 실험에 추가 \(/ }));
      await answer('alias', () => 'pET');

      // 5. 워크플로 노트가 열린다. README 는 친 줄을 지키고 체크리스트 항목을 얻었다(바꿀 때 저장됐다)
      await editorReady(WF_PATH, `${WF.id} ${WF.name}`);
      await waitFor(() => expect(vault.files()[README_PATH]).toContain(TYPED));
      const readmeAfterWorkflow = vault.files()[README_PATH];
      expect(readmeAfterWorkflow).toContain(`${WF.id} ${WF.name} pET`);
      expect(readmeAfterWorkflow).toContain(WF_FILE.replace(/\.md$/, ''));

      // 6. 보기 머리의 주 동작 "UO 추가" → HW 공정, 별칭 "37C"
      const insertButton = await screen.findByRole('button', { name: 'UO 추가' });
      await waitFor(() => expect((insertButton as HTMLButtonElement).disabled).toBe(false));
      const beforeOp = currentView().state.doc.toString();
      const depthBefore = undoDepth(currentView().state);
      await user.click(insertButton);
      await answer('pick', itemStarting(`${OP.id}:`));
      await answer('alias', () => '37C');
      const heading = `### [${OP.id} ${OP.name}] 37C`;
      await waitFor(() => expect(currentView().state.doc.toString()).toContain(heading));
      const afterOp = currentView().state.doc.toString();
      expect(addedLines(beforeOp, afterOp)).toBeDefined();
      const tocLines = afterOp.split('\n').filter((l) => /^\s*- \[UHW010 /.test(l));
      expect(tocLines).toHaveLength(1);
      expect(tocLines[0]).toContain('37C');
      expect(currentView().state.selection.main.head).toBe(afterOp.indexOf(heading));
      // 블록과 목차가 되돌리기 한 번이다
      expect(undoDepth(currentView().state)).toBe(depthBefore + 1);
      act(() => void undo(currentView()));
      expect(currentView().state.doc.toString()).toBe(beforeOp);
      act(() => void redo(currentView()));
      expect(currentView().state.doc.toString()).toBe(afterOp);

      // 7. 새 블록의 Meta End_date 에 "날짜 및 시간 삽입"
      const endDate = afterOp.indexOf("- End_date: ''", afterOp.indexOf(heading));
      expect(endDate).toBeGreaterThan(0);
      act(() => currentView().dispatch({ selection: { anchor: endDate + "- End_date: ''".length } }));
      await palette('Insert date and time');
      await waitFor(() => expect(currentView().state.doc.toString()).toMatch(FILLED_END_DATE));

      // 8. 상태를 failed 로(워크플로 노트에서: 그 실험의 README 를 바꾼다)
      await palette('Change experiment status');
      await answer('pick', () => 'failed');
      await waitFor(() => expect(vault.files()[README_PATH]).toMatch(/^status: failed$/m));

      // 9. 다시 하기: 제목은 다음 차수, README 의 retry_of 는 원래 실험
      await palette('Retry this experiment');
      const retryPrompt = await answer('prompt', (spec) => spec.opts.value);
      expect(retryPrompt.opts.value).toBe('형질전환 2차');
      await editorReady(RETRY_README, 'retry_of');

      // 끝: 파일 내용(날짜는 가림)
      const files = vault.files();
      const settings = fromPluginData(undefined);
      const stamp = readmeStamp(settings);
      const base = createLabnoteStructure('.', TITLE, [], undefined, { locale: 'ko' }).readmeContent;
      expect(maskDates(created)).toBe(maskDates(base));
      const expectedReadme = stamp(
        setFrontMatterKeys(
          stamp(insertWorkflowChecklistEntries(base + TYPED, [{ done: false, title: `${WF.id} ${WF.name} pET`, fileName: WF_FILE }])),
          { status: 'failed' },
        ),
      );
      expect(maskDates(files[README_PATH])).toBe(maskDates(expectedReadme));

      const retryBase = createLabnoteStructure('.', '형질전환 2차', ['001_형질전환_1차'], undefined, { locale: 'ko' }).readmeContent;
      const expectedRetry = copyFrontMatterKeys(files[README_PATH], setRetryOf(retryBase, retryOfLink(DIR)), ['author', 'project']);
      expect(maskDates(files[RETRY_README])).toBe(maskDates(expectedRetry));
      expect(files[RETRY_README]).toContain('retry_of');

      // 워크플로 노트: 템플릿의 줄은 그대로, 더한 것은 블록과 목차 한 줄, End_date 는 채워졌다
      const wfSaved = files[WF_PATH];
      expect(wfSaved).toContain(heading);
      expect(wfSaved.split('\n').filter((l) => /^\s*- \[UHW010 /.test(l))).toHaveLength(1);
      expect(wfSaved).toMatch(FILLED_END_DATE);
      expect(addedLines(beforeOp, wfSaved.replace(/- End_date: '[^']+'/, "- End_date: ''"))).toBeDefined();

      // 알림: 모두 한국어, 만들기·상태·다시 하기를 알렸다
      await waitFor(() => expect(toasts.all.some((x) => x.message.includes('002_형질전환_2차'))).toBe(true));
      toasts.stop();
      const messages = toasts.all.map((x) => x.message);
      for (const m of messages) expect(m).toMatch(/[가-힣]/);
      expect(messages).toContain(coreT('Experiment created: {0}', '001_형질전환_1차'));
      expect(messages).toContain(coreT('Workflow created: {0}', WF_FILE));
      expect(messages.some((m) => m.includes('001_형질전환_1차') && m.includes('→ failed'))).toBe(true);
      expect(messages).toContain(coreT('Experiment created: {0}', '002_형질전환_2차'));
      expect(toasts.all.filter((x) => x.kind === 'error')).toEqual([]);

      // 영구 삭제는 없었다. style 속성도 없다(<html> 의 --side-w 같은 배치 변수는 layoutStore 가 CSSOM 으로 건 것이라 body 만 본다)
      expect(vault.log.filter((c) => c.cmd === 'vault_remove')).toEqual([]);
      expect([...document.body.querySelectorAll('[style]')].map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    },
    60_000,
  );

  it('Ctrl+P "Insert date" in a table cell puts the date at the cell caret and returns focus to the live cell', async () => {
    const user = userEvent.setup();
    const NOTE = 'notes/표.labnote.md';
    const TABLE = '| 시료 | 부피 |\n| --- | --- |\n| A | 1234 |\n';
    vault = installFakeVault({ [NOTE]: `# 표\n\n${TABLE}` });
    render(<App />);
    await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
    await user.click(await screen.findByRole('treeitem', { name: /^표/ }));
    await editorReady(NOTE, '| A | 1234 |');

    // 칸(A 행의 부피)에 들어가 커서를 "12|34" 로 옮긴다(선택만 바뀌는 셀 편집기 트랜잭션)
    const outer = currentView();
    const tableFrom = outer.state.doc.toString().indexOf('| 시료');
    act(() => void focusCell(outer, tableFrom, 1, 1, 'end'));
    const cell = activeCellView(outer)!;
    expect(cell.state.doc.toString()).toBe('1234');
    act(() => cell.dispatch({ selection: { anchor: 2 } }));
    // (b) 바깥 선택도 칸 안의 같은 자리를 따라간다
    expect(outer.state.selection.main.head).toBe(outer.state.doc.toString().indexOf('1234') + 2);
    expect(deepActiveElement()).toBe(cell.contentDOM);

    // 팔레트가 열리면 초점은 고르기 입력으로 간다. 셀 편집기는 걷히지 않아야 한다
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'p', code: 'KeyP', ctrlKey: true });
    });
    await waitFor(() => expect(document.activeElement?.closest('.dialog-layer')).toBeTruthy());
    expect(activeCellView(outer)).toBe(cell);
    await answer('pick', itemStarting(paletteName('Insert date')));

    await waitFor(() => expect(outer.state.doc.toString()).toMatch(/\| A \| 12\d{4}-\d{2}-\d{2}34 \|/));
    expect(activeCellView(outer)).toBe(cell);
    expect(cell.state.doc.toString()).toMatch(/^12\d{4}-\d{2}-\d{2}34$/);
    await waitFor(() => expect(deepActiveElement()).toBe(cell.contentDOM));
    // 돌아온 초점은 걷히지 않은 그 셀 편집기에 있고, 이어 친 글자는 날짜 뒤에 들어간다
    expect(activeCellView(outer)).toBe(cell);
    expect(cell.state.selection.main.head).toBe('12'.length + 10);
  });
});
