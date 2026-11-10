// @vitest-environment jsdom
/**
 * "Open sample definition", 편집기 메뉴의 "Go to definition"·"Add sample"(plan SP5 Task 24).
 * 플러그인 main.ts 의 openSampleDefinitionCommand·addSampleFromEditor·editor-menu 를 앱 호스트로 돌린다.
 * 정의 창은 dialogStore 의 openSampleDefinitionDialog 를 가로채 고른 답을 돌려준다(창 자체는 Task 23 의 테스트가 본다).
 */
import { act } from '@testing-library/react';
import { activeCellView, focusCell } from '../../editor/table/cellEditor';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { clearCommandsForTest, commandById } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';
import { runCommand } from '../../labnote/commands/runCommand';
import * as dialogs from '../../labnote/host/dialogStore';
import { editorMenu } from '../../labnote/menus';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { coreT } from '../../labnote/i18n';
import { addSampleFromEditor } from '../../labnote/port/sampleCommands';
import type { MenuAction, MenuItem } from '../../labnote/ui/menuStore';
import { runSampleDefinition } from '../definitionFlow';
import { createSampleEnv } from '../env';
import { LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

vi.mock('../../labnote/host/dialogStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../labnote/host/dialogStore')>();
  return { ...real, openSampleDefinitionDialog: vi.fn(real.openSampleDefinitionDialog) };
});
const openDialog = vi.mocked(dialogs.openSampleDefinitionDialog);

let hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>) => {
  const th = createTestHost(...a);
  hosts.push(th);
  return th;
};
const lang = getLang();
beforeEach(() => {
  setLang('en');
  registerAllCommands();
  openDialog.mockReset();
  openDialog.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  clearCommandsForTest();
  vi.restoreAllMocks();
  setLang(lang);
});

const CMD = 'open-sample-definition';
const run = async (th: TestHost) => {
  await act(async () => void (await runCommand(th.ctx, commandById(CMD)!)));
};
const keys = (items: MenuItem[]) => items.filter((i): i is MenuAction => !i.separator).map((i) => i.labelKey ?? i.label);
const GEN = 1700000000000;
/** core generateSampleId adds a counter when Date.now() repeats, so each test that generates takes its own time. */
const CELL_GEN = GEN + 1;

describe('open-sample-definition', () => {
  it('opens the reference under the cursor (ID or alias)', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: SAMPLE_VAULT[NOTE].indexOf('pUC and') + 1 } }));
    await run(th);
    expect(openDialog).toHaveBeenCalledTimes(1);
    const model = openDialog.mock.calls[0][0];
    expect(model.title).toContain('DNA-1');
    expect(model.rows.find((r) => r.label === coreT('Scope'))?.value).toBe(coreT('Local'));
    // 사용처는 창이 열린 뒤에 채워진다: 이 노트의 줄들
    const groups = await openDialog.mock.calls[0][1];
    expect(groups.flatMap((g) => g.spots.map((s) => s.path))).toContain(NOTE);
    expect(th.asked.pick).toHaveLength(0);
  });

  it('without a reference, picks from Local and Global samples', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: 1 } })); // '# clone'
    th.answer.pick((items) => items.find((i) => i.label.startsWith('Reagent-7'))!.value);
    await run(th);
    const labels = th.asked.pick[0].items.map((i) => i.label);
    expect(labels.some((l) => l.startsWith('DNA-1 | pUC'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Reagent-7 | Taq'))).toBe(true);
    expect(th.asked.pick[0].opts?.title).toBe(coreT('Open sample definition'));
    expect(openDialog.mock.calls[0][0].title).toContain('Reagent-7');
    expect(openDialog.mock.calls[0][0].rows.find((r) => r.label === coreT('Scope'))?.value).toBe(coreT('Global'));
  });

  it('closing the picker opens nothing', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: 1 } }));
    await run(th);
    expect(th.asked.pick).toHaveLength(1);
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('with tracking off it explains why and opens nothing', async () => {
    const th = host(SAMPLE_VAULT);
    await th.mount('labnote/062_Gel/001_run.labnote.md');
    await run(th);
    expect(th.notes.at(-1)!.message).toBe(coreT("Sample tracking is off for this experiment: its README sets sample_tracking: 'no'."));
    expect(openDialog).not.toHaveBeenCalled();
    expect(th.asked.pick).toHaveLength(0);
  });

  it('with the global switch off the notice names the app command', async () => {
    const th = host(SAMPLE_VAULT, { sampleTracking: false });
    await th.mount(NOTE);
    await run(th);
    expect(th.notes.at(-1)!.message).toBe(coreT('Sample tracking is turned off in {0}.', t('cmd.sampleSettings')));
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('an unregistered reference names the ID in a notice', async () => {
    const text = `${SAMPLE_VAULT[NOTE]}DNA-99\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: text });
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: text.indexOf('DNA-99') + 2 } }));
    await run(th);
    expect(openDialog).not.toHaveBeenCalled();
    expect(th.notes.at(-1)!.message).toContain('DNA-99');
  });
});

describe('runSampleDefinition', () => {
  const def = () => ({
    scope: 'local' as const,
    folder: LOCAL,
    type: 'DNA',
    id: 'DNA-1',
    record: JSON.parse(SAMPLE_VAULT[`${LOCAL}/DNA.json`])['DNA-1'],
  });

  it('Open JSON file and a usage spot open the file', async () => {
    const th = host(SAMPLE_VAULT);
    await th.mount(NOTE);
    const env = createSampleEnv(th.ctx);
    openDialog.mockResolvedValueOnce({ action: 'openJson' });
    await act(() => runSampleDefinition(env, def(), { docPath: NOTE }));
    openDialog.mockResolvedValueOnce({ open: { path: 'labnote/061_PCR/README.labnote.md', line: 2 } });
    await act(() => runSampleDefinition(env, def(), { docPath: NOTE }));
    expect(th.opened.slice(-2)).toEqual([`${LOCAL}/DNA.json`, 'labnote/061_PCR/README.labnote.md']);
  });

  it('a flow that is cancelled brings the window back; a finished one tells the panel', async () => {
    const th = host(SAMPLE_VAULT);
    await th.mount(NOTE);
    const env = createSampleEnv(th.ctx);
    const changed = vi.spyOn(env, 'changed');
    openDialog.mockResolvedValueOnce({ action: 'edit' }).mockResolvedValueOnce({ action: 'discard' }).mockResolvedValueOnce(undefined);
    // edit: the alias prompt is closed → back to the window; discard: keep the location → done
    th.answer.prompt(undefined);
    th.answer.pick(() => false);
    await act(() => runSampleDefinition(env, def(), { docPath: NOTE }));
    expect(openDialog).toHaveBeenCalledTimes(2);
    expect(JSON.parse(th.vault.files()[`${LOCAL}/DNA.json`])['DNA-1'].discarded).toBeTruthy();
    expect(changed).toHaveBeenCalledWith([LOCAL]);
  });

  it('a refused flow that still changed the record reopens the window on the fresh record', async () => {
    const th = host(SAMPLE_VAULT);
    await th.mount(NOTE);
    const env = createSampleEnv(th.ctx);
    openDialog.mockResolvedValueOnce({ action: 'delete' }).mockResolvedValueOnce(undefined);
    // Delete is refused (DNA-1 is used) → Mark as discarded → keep the location
    th.answer.confirm(true);
    th.answer.pick(() => false);
    await act(() => runSampleDefinition(env, def(), { docPath: NOTE }));
    expect(openDialog).toHaveBeenCalledTimes(2);
    expect(JSON.parse(th.vault.files()[`${LOCAL}/DNA.json`])['DNA-1'].discarded).toBeTruthy();
    const reopened = openDialog.mock.calls[1][0];
    expect(reopened.actions).toContain('undiscard');
    expect(reopened.actions).not.toContain('discard');
    expect(reopened.rows.some((r) => r.label === coreT('Discarded'))).toBe(true);
  });

  it('a refused flow whose record is gone does not reopen the window', async () => {
    const th = host(SAMPLE_VAULT);
    await th.mount(NOTE);
    const env = createSampleEnv(th.ctx);
    openDialog.mockImplementationOnce(async () => {
      const db = JSON.parse(th.vault.files()[`${LOCAL}/DNA.json`]);
      delete db['DNA-1'];
      await env.fs.write(`${LOCAL}/DNA.json`, JSON.stringify(db));
      return { action: 'edit' };
    });
    th.answer.prompt(undefined);
    await act(() => runSampleDefinition(env, def(), { docPath: NOTE }));
    expect(openDialog).toHaveBeenCalledTimes(1);
  });
});

/** 편집기 메뉴의 "실험 노트" 구역(샘플 항목은 그 앞쪽에 온다). */
const labSection = (items: MenuItem[]) => items.slice(Math.max(0, items.findIndex((i) => i.section !== undefined)));

describe('editor menu', () => {
  it('the editor menu has Go to definition on a reference and Add sample always', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: SAMPLE_VAULT[NOTE].indexOf('DNA-1;pUC and') + 2 } }));
    const items = labSection(editorMenu(th.ctx, NOTE));
    expect(keys(items).slice(0, 2)).toEqual(['samples.menu.goToDefinition', 'samples.menu.addSample']);
    expect(t('samples.menu.goToDefinition')).toBe('Go to definition');
    await act(async () => void (await runCommand(th.ctx, (items[0] as MenuAction).run)));
    expect(openDialog.mock.calls[0][0].title).toContain('DNA-1');

    act(() => m.view().dispatch({ selection: { anchor: 1 } }));
    expect(keys(editorMenu(th.ctx, NOTE))).toContain('samples.menu.addSample');
    expect(keys(editorMenu(th.ctx, NOTE))).not.toContain('samples.menu.goToDefinition');

    const gel = 'labnote/062_Gel/001_run.labnote.md';
    const g = await th.mount(gel);
    act(() => g.view().dispatch({ selection: { anchor: SAMPLE_VAULT[gel].indexOf('DNA-1') + 1 } }));
    const gelKeys = keys(editorMenu(th.ctx, gel));
    expect(gelKeys).not.toContain('samples.menu.addSample');
    expect(gelKeys).not.toContain('samples.menu.goToDefinition');
  });

  it('Go to definition follows the cursor in the table cell being edited', async () => {
    const table = '| a | b |\n|---|---|\n| see DNA-1 | y |';
    const text = `x\n\n${table}\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: text });
    const m = await th.mount(NOTE);
    const outer = m.view();
    const tableFrom = text.indexOf(table);
    act(() => void focusCell(outer, tableFrom, 1, 0, 'start'));
    // 이미 열린 칸 안에서 커서만 옮긴다(칸을 클릭한 것과 같은 길): 바깥 커서는 칸 처음("see")에 남는다
    act(() => void focusCell(outer, tableFrom, 1, 0, 6));
    const cell = activeCellView(outer)!;
    expect(cell.state.selection.main.head).toBe(6);
    expect(outer.state.selection.main.head).toBe(text.indexOf('see DNA-1'));
    const items = labSection(editorMenu(th.ctx, NOTE));
    expect(keys(items).slice(0, 2)).toEqual(['samples.menu.goToDefinition', 'samples.menu.addSample']);
    await act(async () => void (await runCommand(th.ctx, (items[0] as MenuAction).run)));
    expect(openDialog.mock.calls[0][0].title).toContain('DNA-1');
  });

  it('Korean labels are the plugin text', () => {
    setLang('ko');
    expect(t('samples.menu.goToDefinition')).toBe(coreT('Go to definition'));
    expect(t('samples.menu.addSample')).toBe(coreT('Add sample'));
  });
});

describe('Add sample', () => {
  it('Add sample: choose type → generate → inserts the reference at the cursor', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: m.view().state.doc.length } }));
    vi.spyOn(Date, 'now').mockReturnValue(GEN);
    th.answer.pick('DNA');
    th.answer.prompt('pBR', 'backbone', '');
    await act(() => addSampleFromEditor(createSampleEnv(th.ctx)));
    expect(th.asked.pick[0].opts?.title).toBe(coreT('Select sample type'));
    expect(m.view().state.doc.toString()).toContain(`DNA-${GEN};pBR`);
    expect(JSON.parse(th.vault.files()[`${LOCAL}/DNA.json`])[`DNA-${GEN}`].alias).toBe('pBR');
  });

  // #544: the type picker took the focus and the editor then reported the start of the note, so the
  // reference landed below the last section instead of where the user was writing.
  it('inserts at the cursor read before the type picker, not where the editor reports it after', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    const saved = '# clone\n'.length; // the empty line under the title
    act(() => m.view().dispatch({ selection: { anchor: saved } }));
    vi.spyOn(Date, 'now').mockReturnValue(GEN + 2);
    th.answer.pick(() => {
      m.view().dispatch({ selection: { anchor: 0 } }); // what the editor says once the dialog closed
      return 'DNA';
    });
    th.answer.prompt('pBR', '', '');
    await act(() => addSampleFromEditor(createSampleEnv(th.ctx)));
    const doc = m.view().state.doc.toString();
    expect(doc.indexOf(`DNA-${GEN + 2};pBR`)).toBeGreaterThan(0);
    expect(doc.indexOf(`DNA-${GEN + 2};pBR`)).toBeLessThan(doc.indexOf('@dna;DNA-1'));
  });

  it('a catalog type searches the catalog instead of generating', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: m.view().state.doc.length } }));
    th.answer.pick('Reagent', 'Reagent-900');
    await act(() => addSampleFromEditor(createSampleEnv(th.ctx)));
    expect(th.asked.prompt).toHaveLength(0);
    expect(m.view().state.doc.toString()).toContain('Reagent-900;dNTP');
  });

  it('without an open note it says so', async () => {
    const th = host(SAMPLE_VAULT);
    await act(() => addSampleFromEditor(createSampleEnv(th.ctx)));
    expect(th.notes.at(-1)!.message).toBe(coreT('Open a note to insert into.'));
    expect(th.asked.pick).toHaveLength(0);
  });

  it("Add sample into an active cell keeps the row's cell count", async () => {
    const table = '| a | b |\n|---|---|\n| x | y |';
    const text = `${SAMPLE_VAULT[NOTE]}\n${table}\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: text });
    const m = await th.mount(NOTE);
    const outer = m.view();
    act(() => void focusCell(outer, text.indexOf(table), 1, 0, 'end'));
    expect(activeCellView(outer)?.state.doc.toString()).toBe('x');
    vi.spyOn(Date, 'now').mockReturnValue(CELL_GEN);
    th.answer.pick('DNA');
    th.answer.prompt('p|q', '', '');
    await act(() => addSampleFromEditor(createSampleEnv(th.ctx)));
    const row = m.view().state.doc.toString().split('\n').find((l) => l.includes(`DNA-${CELL_GEN}`))!;
    expect(row).toBe(`| xDNA-${CELL_GEN};p\\|q | y |`);
    expect(row.split(/(?<!\\)\|/).length).toBe('| x | y |'.split('|').length);
  });
});
