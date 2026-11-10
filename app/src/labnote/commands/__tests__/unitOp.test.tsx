// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { undo } from '@codemirror/commands';
import { rebuildUnitOpToc, type PickItem } from '@labnoteo/core';
import { buildHwUnitOpMarkdown } from '@labnoteo/core/lib/unitOpTemplate';
import { createWorkflowContent, createWorkflowFileName } from '@labnoteo/core/lib/workflowStructure';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { clearCommandsForTest, commandById } from '../registry';
import { registerAllCommands } from '../registerAll';
import { runCommand } from '../runCommand';
import { insertUnitOp, type ChosenUnitOp } from '../unitOp';

const DIR = 'labnote/001_단백질_발현';
const README_PATH = `${DIR}/README.labnote.md`;
const WF = { id: 'WB010', name: 'Protein Expression', description: 'Express a protein.' };
const WF_PATH = `${DIR}/${createWorkflowFileName('001', WF)}`;
const TABLE = '| 시료 | 부피 |\n| --- | --- |\n| A | 10 µL |';

const README = ['---', 'title: 단백질 발현', "author: '김연구'", 'status: in-progress', '---', '', '## 🗂️ Related Workflows', '', ''].join('\n');

function block(opId: string, opName: string): string {
  return buildHwUnitOpMarkdown(
    { opId, opName, opDescription: `${opName} step` },
    { experimenter: '김연구', dateTime: '2026-01-01 09:00' },
  );
}

/** 단위 공정 둘(UHW010, UHW180)이 있고 목차가 맞는 워크플로 노트. 첫 블록의 Method 에 표가 있다. */
function workflowNote(): string {
  const base = createWorkflowContent(WF, '김연구', undefined, { noteId: 'n1' });
  const at = base.indexOf('## Conclusions and Discussion');
  let md = base.slice(0, at).replace(/\n+$/, '\n') + block('UHW010', 'Mixing') + block('UHW180', 'Incubation') + base.slice(at);
  const method = md.indexOf('#### Method\n') + '#### Method\n'.length;
  md = md.slice(0, method) + `${TABLE}\n` + md.slice(method);
  return rebuildUnitOpToc(md);
}

const pickOp = (id: string) => (items: PickItem<unknown>[]) => items.find((i) => (i.value as ChosenUnitOp).op.id === id)?.value;
const maskTimes = (s: string) => s.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, 'T');

/** `before` 의 줄이 모두 같은 순서로 `after` 에 남아 있는가(더하기만 했는가). 더한 줄을 돌려준다. */
function addedLines(before: string, after: string): string[] | undefined {
  const a = before.split('\n');
  const b = after.split('\n');
  const added: string[] = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else added.push(line);
  }
  return i === a.length ? added : undefined;
}

let h: TestHost;

beforeEach(() => setLang('ko'));

afterEach(() => {
  for (const n of h?.notes ?? []) expect(n.message).toMatch(/[가-힣]/);
  h?.cleanup();
});

async function openWorkflow(text = workflowNote()) {
  h = createTestHost({ [README_PATH]: README, [WF_PATH]: text });
  const m = await h.mount(WF_PATH);
  return m;
}

/** 커서를 `needle` 이 있는 곳(그 앞)에 둔다. */
function cursorAt(m: Awaited<ReturnType<typeof openWorkflow>>, needle: string, plus = 0) {
  const v = m.view();
  const at = v.state.doc.toString().indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  act(() => v.dispatch({ selection: { anchor: at + plus } }));
}

describe('insert-unit-operation', () => {
  it('lands after the cursor block, lists it in the TOC in document order, and puts the cursor on the new heading', async () => {
    const m = await openWorkflow();
    cursorAt(m, '### [UHW010 Mixing]', 5);
    h.answer.pick(pickOp('USW010'));
    h.answer.alias('1차');
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx)));

    const doc = m.view().state.doc.toString();
    const mixing = doc.indexOf('### [UHW010 Mixing]');
    const added = doc.indexOf('### [USW010 ');
    const incubation = doc.indexOf('### [UHW180 Incubation]');
    expect(mixing).toBeLessThan(added);
    expect(added).toBeLessThan(incubation);
    expect(doc.slice(added, doc.indexOf('\n', added))).toMatch(/\] 1차$/);

    const toc = doc.split('\n').filter((l) => /^\s*- \[(UHW|USW)\d+ /.test(l));
    expect(toc.map((l) => /\[([A-Z]+\d+) /.exec(l)?.[1])).toEqual(['UHW010', 'USW010', 'UHW180']);
    expect(toc[1]).toContain('1차');

    expect(m.view().state.selection.main.head).toBe(added);
    expect(h.notes).toEqual([{ kind: 'info', message: expect.stringContaining('USW010') }]);
  });

  it('a single undo removes the block and the TOC entry together and restores the exact original text', async () => {
    const original = workflowNote();
    const m = await openWorkflow(original);
    cursorAt(m, '### [UHW180 Incubation]', 5);
    h.answer.pick(pickOp('UHW010'));
    h.answer.alias('');
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx)));
    const after = m.view().state.doc.toString();
    expect(after).not.toBe(original);
    expect(addedLines(original, after)).toBeDefined();
    act(() => void undo(m.view()));
    expect(m.view().state.doc.toString()).toBe(original);
  });

  it('insert-unit-operation in a CRLF note keeps CRLF on save, and the diff touches only the inserted span and the TOC lines', async () => {
    const lf = workflowNote();
    // 같은 삽입을 LF 노트에 한 결과가 기준이다
    let m = await openWorkflow(lf);
    cursorAt(m, '### [UHW010 Mixing]', 5);
    h.answer.pick(pickOp('UHW180'));
    h.answer.alias('2차');
    await act(() => insertUnitOp(h.ctx));
    const expectedLf = m.view().state.doc.toString();
    h.cleanup();

    const crlf = lf.replace(/\n/g, '\r\n');
    m = await openWorkflow(crlf);
    cursorAt(m, '### [UHW010 Mixing]', 5);
    h.answer.pick(pickOp('UHW180'));
    h.answer.alias('2차');
    await act(() => insertUnitOp(h.ctx));
    await act(async () => void (await m.ref.current!.flush()));
    const saved = h.vault.files()[WF_PATH];
    expect(saved).not.toMatch(/[^\r]\n/);
    const savedLf = saved.replace(/\r\n/g, '\n');
    expect(maskTimes(savedLf)).toBe(maskTimes(expectedLf));

    const added = addedLines(lf, savedLf)!;
    expect(added).toBeDefined();
    const tocLines = added.filter((l) => /^\s*- \[UHW180 /.test(l));
    expect(tocLines).toHaveLength(1);
    const blockLines = maskTimes(block('UHW180', 'Incubation')).split('\n').length;
    // 목차 한 줄과 새 블록의 줄만 더했다(블록은 이웃과 빈 줄·구분선을 나눌 수 있어 그보다 많지 않다)
    expect(added.length - tocLines.length).toBeLessThanOrEqual(blockLines);
    expect(added.length - tocLines.length).toBeGreaterThan(10);
  });

  it('with the cursor inside a markdown table in a unit-op block, the block goes after that unit op, not into the table', async () => {
    const m = await openWorkflow();
    cursorAt(m, '| A | 10 µL |', 3);
    h.answer.pick(pickOp('UHW180'));
    h.answer.alias('표 다음');
    await act(() => insertUnitOp(h.ctx));
    const doc = m.view().state.doc.toString();
    expect(doc).toContain(TABLE);
    const table = doc.indexOf(TABLE);
    const added = doc.indexOf('### [UHW180 Incubation] 표 다음');
    const old = doc.indexOf('### [UHW180 Incubation]\n');
    expect(added).toBeGreaterThan(table);
    expect(added).toBeLessThan(old);
  });

  it('with the section heading deleted, it puts it back above the TOC, inserts after the cursor block, and one undo restores (#564)', async () => {
    const original = workflowNote().replace('## Related Unit Operations\n\n', '');
    expect(original).not.toContain('## Related Unit Operations');
    const m = await openWorkflow(original);
    cursorAt(m, '### [UHW010 Mixing]', 5);
    h.answer.pick(pickOp('USW010'));
    h.answer.alias('');
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx)));

    const doc = m.view().state.doc.toString();
    const section = doc.indexOf('## Related Unit Operations');
    expect(section).toBeGreaterThanOrEqual(0);
    const toc = doc.split('\n').filter((l) => /^\s*- \[(UHW|USW)\d+ /.test(l));
    expect(toc.map((l) => /\[([A-Z]+\d+) /.exec(l)?.[1])).toEqual(['UHW010', 'USW010', 'UHW180']);
    expect(doc.indexOf('- [UHW010')).toBeGreaterThan(section);
    // 되살린 제목만큼 밀린 커서로 넣을 곳을 찾는다: 새 블록은 커서가 있던 Mixing 뒤다
    const added = doc.indexOf('### [USW010 ');
    expect(doc.indexOf('### [UHW010 Mixing]')).toBeLessThan(added);
    expect(added).toBeLessThan(doc.indexOf('### [UHW180 Incubation]'));
    expect(m.view().state.selection.main.head).toBe(added);

    act(() => void undo(m.view()));
    expect(m.view().state.doc.toString()).toBe(original);
  });

  it('on a non-workflow note, the reason from workflowPathProblem is shown and no alias is asked', async () => {
    h = createTestHost({ [README_PATH]: README, [WF_PATH]: workflowNote() });
    await h.mount(README_PATH);
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx)));
    expect(h.asked.pick).toHaveLength(0);
    expect(h.asked.alias).toHaveLength(0);
    expect(h.notes).toEqual([{ kind: 'warn', message: expect.stringContaining('README.labnote.md') }]);
    expect(h.vault.files()[README_PATH]).toBe(README);
  });

  it('with a target workflow (Experiments tab), it opens that note and adds the UO after its last one', async () => {
    h = createTestHost({ [README_PATH]: README, [WF_PATH]: workflowNote() });
    // 편집기는 이미 그 노트를 읽었고(앱에서는 openFile 이 바꿔 연다), 열린 노트는 README 다
    const mounted = await h.mount(WF_PATH);
    h.setActive(README_PATH);
    const opened: Array<[string, unknown]> = [];
    h.ctx.openFile = async (path, at) => {
      opened.push([path, at]);
      h.setActive(path);
    };
    h.answer.pick(pickOp('USW010'));
    h.answer.alias('끝');
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx, undefined, { workflowPath: WF_PATH })));
    expect(opened.map(([p]) => p)).toEqual([WF_PATH]);
    const doc = mounted.view().state.doc.toString();
    const headings = doc.split('\n').filter((l) => /^### \[/.test(l));
    expect(headings.map((l) => l.slice(5, 11))).toEqual(['UHW010', 'UHW180', 'USW010']);
  });

  it('with unsaved edits in the target workflow note, the new UO goes after its last UO in the editor text', async () => {
    h = createTestHost({ [README_PATH]: README, [WF_PATH]: workflowNote() });
    const mounted = await h.mount(WF_PATH);
    // 저장하지 않은 줄 여럿을 첫 UO 블록 안에 넣는다: 디스크의 마지막 UO 줄 번호는 편집기에서 첫 UO 블록 안이다
    const view = mounted.view();
    const text = view.state.doc.toString();
    const at = text.indexOf('\n', text.indexOf('### ['));
    view.dispatch({ changes: { from: at, insert: '\n\n- 메모\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n' } });
    // 그 노트가 이미 열린 노트다(저장 전): openFile 은 아무것도 다시 읽지 않는다
    h.ctx.openFile = async (path) => h.setActive(path);
    expect(h.vault.files()[WF_PATH]).toBe(workflowNote());
    h.answer.pick(pickOp('USW010'));
    h.answer.alias('끝');
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx, undefined, { workflowPath: WF_PATH })));
    const headings = mounted.view().state.doc.toString().split('\n').filter((l) => /^### \[/.test(l));
    expect(headings.map((l) => l.slice(5, 11))).toEqual(['UHW010', 'UHW180', 'USW010']);
  });

  it('with a target that is not a workflow note, it says why and opens nothing', async () => {
    h = createTestHost({ [README_PATH]: README });
    const openFile = vi.spyOn(h.ctx, 'openFile');
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx, undefined, { workflowPath: README_PATH })));
    expect(openFile).not.toHaveBeenCalled();
    expect(h.notes).toEqual([{ kind: 'warn', message: expect.stringContaining('README.labnote.md') }]);
  });

  it('with no note open, it asks to open a workflow note', async () => {
    h = createTestHost({ [README_PATH]: README });
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx)));
    expect(h.asked.pick).toHaveLength(0);
    expect(h.notes).toEqual([{ kind: 'warn', message: h.host.t('Please open a workflow file.') }]);
  });

  it('while the editor is busy (kept conflict), it refuses with command.noteBusy and the doc is unchanged', async () => {
    const user = userEvent.setup();
    const theirs = `${workflowNote()}바깥 변경\n`;
    const m = await openWorkflow();
    await m.type('!');
    const mine = m.view().state.doc.toString();
    await h.vault.mem.write(WF_PATH, theirs);
    await act(() => h.vault.emitChange(WF_PATH, 'modified'));
    await user.click(await screen.findByRole('button', { name: '그대로 두기' }));
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx)));
    expect(h.notes).toEqual([{ kind: 'warn', message: t('command.noteBusy') }]);
    expect(h.asked.pick).toHaveLength(0);
    expect(m.view().state.doc.toString()).toBe(mine);
    expect(h.vault.files()[WF_PATH]).toBe(theirs);
  });

  it('if the doc changes during the batch, NoteChangedError is reported and nothing is inserted', async () => {
    const m = await openWorkflow();
    cursorAt(m, '### [UHW010 Mixing]', 5);
    h.answer.pick(pickOp('UHW180'));
    h.answer.alias(() => {
      // 별칭을 낸 뒤 묶음 안의 첫 파일 읽기(README 확인) 사이에 노트가 바뀐다
      const exists = h.host.fs.exists.bind(h.host.fs);
      let once = true;
      h.host.fs.exists = async (p: string) => {
        if (once) {
          once = false;
          m.view().dispatch({ changes: { from: m.view().state.doc.length, insert: '사용자 입력' } });
        }
        return exists(p);
      };
      return '';
    });
    const before = m.view().state.doc.toString();
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx)));
    expect(h.notes).toEqual([{ kind: 'warn', message: t('command.noteChanged') }]);
    expect(m.view().state.doc.toString()).toBe(`${before}사용자 입력`);
  });

  it('registerAllCommands registers insert-unit-operation', () => {
    h = createTestHost();
    clearCommandsForTest();
    registerAllCommands();
    expect(commandById('insert-unit-operation')?.nameKey).toBe('Insert unit operation');
    clearCommandsForTest();
  });
});
