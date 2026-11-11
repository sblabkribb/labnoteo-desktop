// @vitest-environment jsdom
/**
 * Workflow 완료 표시: 저장되는 것은 플러그인처럼 README "Related Workflows" 체크리스트의 [ ] / [x] 하나다.
 * - workflowTickIn: README 글에서 그 Workflow 노트의 체크 상태를 읽는다(보기 머리의 칩).
 * - toggleWorkflowTick: 예전 꼴의 줄(앞의 "- " 없음, *, 들여쓰기, [X], CRLF, 위키링크)도 상자 글자만 바꾼다.
 * - uoAllDoneWatch / offerWorkflowDoneNudge: 모든 Unit Operation 이 끝나면 알림 단추로만 묻는다(저절로 바꾸지 않는다).
 */
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { workflowTickIn } from '../../notePosition';
import { uoAllDoneWatch } from '../statusNudge';
import { offerWorkflowDoneNudge, toggleWorkflowTick } from '../workflow';
import { appCommandById, clearAppCommandsForTest, registerAllAppCommands } from '../../../editor/commands/appCommands';

const DIR = 'labnote/003_E_coli_host';
const README_PATH = `${DIR}/README.labnote.md`;
const WF = '001_WB030_DNA_Assembly_Gibson_run.labnote.md';
const WF_PATH = `${DIR}/${WF}`;

function readme(lines: string[], eol = '\n'): string {
  return ['---', 'title: 대장균', 'status: in-progress', 'last_updated_date: 2026-01-01', '---', '', '## 🗂️ Related Workflows', '', ...lines, '', '## Summary and Discussion', ''].join(eol);
}

/** 한 줄로 바꿀 수 있는 체크리스트의 꼴들(플러그인 정규식이 받는 것). */
const FORMS: Record<string, (box: string) => string> = {
  dash: (b) => `- [${b}] [WB030 DNA Assembly Gibson run](./${WF})`,
  bare: (b) => `[${b}] [WB030 DNA Assembly Gibson run](./${WF})`,
  star: (b) => `* [${b}] [WB030 DNA Assembly Gibson run](${WF})`,
  indented: (b) => `  - [${b}] [WB030 DNA Assembly Gibson run](./${WF})`,
  wiki: (b) => `- [${b}] [[${WF.slice(0, -'.md'.length)}|WB030 DNA Assembly Gibson run]]`,
};

let h: TestHost;

beforeEach(() => setLang('ko'));
afterEach(() => h?.cleanup());

describe('workflowTickIn', () => {
  it.each(Object.keys(FORMS))('reads the tick of a %s line', (form) => {
    expect(workflowTickIn(readme([FORMS[form](' ')]), WF_PATH)).toBe(false);
    expect(workflowTickIn(readme([FORMS[form]('x')]), WF_PATH)).toBe(true);
  });

  it('reads [X], CRLF and a different case of the file name', () => {
    expect(workflowTickIn(readme([FORMS.dash('X')], '\r\n'), WF_PATH)).toBe(true);
    expect(workflowTickIn(readme([FORMS.bare(' ')], '\r\n'), WF_PATH.toUpperCase().replace('LABNOTE/', 'labnote/'))).toBe(false);
  });

  it('is undefined when the checklist has no line for that note', () => {
    expect(workflowTickIn(readme([`- [x] [WD010 Design](./003_WD010_Design.labnote.md)`]), WF_PATH)).toBeUndefined();
    expect(workflowTickIn('', WF_PATH)).toBeUndefined();
  });
});

describe('toggleWorkflowTick keeps legacy lines', () => {
  it.each(Object.keys(FORMS))('a %s line changes only its box, both ways', async (form) => {
    h = createTestHost({ [README_PATH]: readme([FORMS[form](' ')]), [WF_PATH]: '---\ntitle: w\n---\n' });
    expect(await toggleWorkflowTick(h.ctx, DIR, WF)).toBe(true);
    let text = h.vault.files()[README_PATH];
    expect(text).toContain(`\n${FORMS[form]('x')}\n`);
    expect(await toggleWorkflowTick(h.ctx, DIR, WF)).toBe(false);
    text = h.vault.files()[README_PATH];
    expect(text).toContain(`\n${FORMS[form](' ')}\n`);
  });

  it('[X] with CRLF unticks and keeps every line ending', async () => {
    h = createTestHost({ [README_PATH]: readme([FORMS.bare('X')], '\r\n'), [WF_PATH]: '---\ntitle: w\n---\n' });
    expect(await toggleWorkflowTick(h.ctx, DIR, WF)).toBe(false);
    const text = h.vault.files()[README_PATH];
    expect(text).toContain(`\r\n${FORMS.bare(' ')}\r\n`);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

const uoNote = (end1: string, end2: string) =>
  [
    '---',
    'title: WB030 DNA Assembly',
    '---',
    '## [WB030 DNA Assembly] Gibson run',
    '',
    '### [UHW250 DNA Assembly] a',
    '#### Meta',
    `- End_date: ${end1}`,
    '',
    '### [UHW180 Incubation] b',
    '#### Meta',
    `- End_date: ${end2}`,
    '',
  ].join('\n');

describe('uoAllDoneWatch', () => {
  function view(doc: string, onAllDone: () => void) {
    return new EditorView({ state: EditorState.create({ doc, extensions: [uoAllDoneWatch(onAllDone)] }) });
  }
  /** 두 번째 UO 의 End_date 줄 끝에 글을 넣는다. */
  function type(v: EditorView, insert: string, userEvent: string) {
    const doc = v.state.doc.toString();
    const at = doc.indexOf('\n', doc.lastIndexOf('End_date: '));
    v.dispatch({ changes: { from: at, insert }, annotations: Transaction.userEvent.of(userEvent) });
  }

  it('fires once when typing makes the last UO end', () => {
    const fn = vi.fn();
    const v = view(uoNote('2026-01-02', ''), fn);
    type(v, '2026-01-', 'input.type');
    expect(fn).not.toHaveBeenCalled();
    type(v, '03', 'input.type');
    expect(fn).toHaveBeenCalledTimes(1);
    // 이미 다 끝난 뒤의 입력은 다시 묻지 않는다
    type(v, ' ', 'input.type');
    expect(fn).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it('does not fire for a command edit, an undo, or while a UO is still open', () => {
    const fn = vi.fn();
    const a = view(uoNote('2026-01-02', ''), fn);
    type(a, '2026-01-03', 'input.labnote');
    a.destroy();
    const b = view(uoNote('2026-01-02', ''), fn);
    type(b, '2026-01-03', 'undo');
    b.destroy();
    const c = view(uoNote('', ''), fn);
    type(c, '2026-01-03', 'input.type');
    c.destroy();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('offerWorkflowDoneNudge', () => {
  it('asks with one button when the README has not ticked it, and the button ticks it', async () => {
    h = createTestHost({ [README_PATH]: readme([FORMS.bare(' ')]), [WF_PATH]: uoNote('2026-01-02', '2026-01-03') });
    expect(await offerWorkflowDoneNudge(h.ctx, WF_PATH)).toBe(true);
    const i = h.noteOpts.findIndex((o) => o.action);
    expect(h.notes[i].message).toBe('모든 Unit Operation 이 끝났습니다. Workflow 도 완료로 표시할까요?');
    expect(h.noteOpts[i].action?.label).toBe('완료로 표시');
    // 누르기 전에는 아무것도 바뀌지 않는다
    expect(h.vault.files()[README_PATH]).toContain(`\n${FORMS.bare(' ')}\n`);
    h.noteOpts[i].action!.run();
    await vi.waitFor(() => expect(h.vault.files()[README_PATH]).toContain(`\n${FORMS.bare('x')}\n`));
  });

  it('stays quiet when it is already ticked or not in the checklist', async () => {
    h = createTestHost({ [README_PATH]: readme([FORMS.dash('x')]), [WF_PATH]: uoNote('2026-01-02', '2026-01-03') });
    expect(await offerWorkflowDoneNudge(h.ctx, WF_PATH)).toBe(false);
    h.cleanup();
    h = createTestHost({ [README_PATH]: readme([]), [WF_PATH]: uoNote('2026-01-02', '2026-01-03') });
    expect(await offerWorkflowDoneNudge(h.ctx, WF_PATH)).toBe(false);
    expect(h.notes).toEqual([]);
  });
});

describe('palette command app.toggleWorkflowDone', () => {
  afterEach(() => clearAppCommandsForTest());

  it('shows only on an open Workflow note and toggles its README line', async () => {
    registerAllAppCommands();
    const cmd = appCommandById('app.toggleWorkflowDone')!;
    expect(cmd).toBeDefined();
    h = createTestHost({ [README_PATH]: readme([FORMS.bare(' ')]), [WF_PATH]: '---\ntitle: w\n---\n' });
    h.setActive(README_PATH);
    expect(cmd.available!(h.ctx)).toBe(false);
    h.setActive(WF_PATH);
    expect(cmd.available!(h.ctx)).toBe(true);
    await cmd.run(h.ctx);
    expect(h.vault.files()[README_PATH]).toContain(`\n${FORMS.bare('x')}\n`);
  });
});
