// @vitest-environment jsdom
/**
 * 샘플 참조 넣기와 "이 실험의 시료 목록 삽입"(plan SP5 Task 19). vendor tests/plugin/sampleActions.test.ts 의
 * insertSampleReference 묶음과 "insertExperimentSamplesTable with a table already there" 묶음을 앱 호스트로 옮겼다.
 * 플러그인의 가짜 EditTarget 대신 진짜 편집기를 연다(되돌리기와 셀 편집기까지 본다). markUserEdit 확인은 앱에 그 일이
 * 없어 뺐다.
 */
import { act } from '@testing-library/react';
import { undo } from '@codemirror/commands';
import type { EditTarget } from '@labnoteo/core';
import { upsertSampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { activeCellView, focusCell } from '../../editor/table/cellEditor';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { clearCommandsForTest, commandById } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';
import { runCommand } from '../../labnote/commands/runCommand';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { coreT } from '../../labnote/i18n';
import { insertExperimentSamplesTable, insertSampleReference } from '../../labnote/port/sampleInsert';
import { createSampleEnv } from '../env';
import { LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

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
});
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  clearCommandsForTest();
  setLang(lang);
});

const CMD = 'insert-experiment-samples-table';
const run = async (th: TestHost) => {
  await act(async () => void (await runCommand(th.ctx, commandById(CMD)!)));
};
const lastNote = (th: TestHost) => th.notes.at(-1)?.message ?? '';

describe('insertSampleReference', () => {
  /** A minimal EditTarget backed by a mutable string + cursor (vendor makeTarget). */
  function makeTarget(text: string, cursor: number, selectionEnd?: number) {
    const state = { text, revealed: -1 };
    const target: EditTarget = {
      path: 'labnote/001_Test/001_WD010_Design.labnote.md',
      getText: async () => state.text,
      getCursorOffset: async () => cursor,
      getSelectionRange: async () => (selectionEnd === undefined ? undefined : { start: cursor, end: selectionEnd }),
      insertAtCursor: async (s: string) => {
        state.text = state.text.slice(0, cursor) + s + state.text.slice(cursor);
      },
      replaceRange: async (start: number, end: number, s: string) => {
        state.text = state.text.slice(0, start) + s + state.text.slice(end);
      },
      revealOffset: async (offset: number) => {
        state.revealed = offset;
      },
    };
    return { target, state };
  }
  const env = () => createSampleEnv(host().ctx);

  it('appends below the last section when the cursor sits in the front matter', async () => {
    const doc = '---\nstatus: planned\n---\n\n## Summary\n';
    const { target, state } = makeTarget(doc, 10); // inside front matter
    await insertSampleReference(env(), target, 'RNA-1;siKIF');
    expect(state.text).toBe(doc + 'RNA-1;siKIF\n');
    expect(state.revealed).toBeGreaterThanOrEqual(0);
  });

  it('appends to the line end when the cursor is on an existing reference', async () => {
    const doc = '## Samples\nused RNA-2;siX here\n';
    const { target, state } = makeTarget(doc, doc.indexOf('RNA-2') + 2);
    await insertSampleReference(env(), target, 'RNA-1;siKIF');
    expect(state.text).toBe('## Samples\nused RNA-2;siX here RNA-1;siKIF\n');
  });

  // #302: the selected template hint stayed, with the reference fused to it.
  it('replaces the selected text', async () => {
    const doc = '#### Input\n- (samples from the previous step)\n';
    const start = doc.indexOf('(');
    const { target, state } = makeTarget(doc, start, doc.indexOf(')') + 1);
    await insertSampleReference(env(), target, 'Plasmid-1;pET-28a(+)');
    expect(state.text).toBe('#### Input\n- Plasmid-1;pET-28a(+)\n');
    expect(state.revealed).toBe(start + 'Plasmid-1;pET-28a(+)'.length);
  });

  it("insertSampleReference into an active cell keeps the row's cell count", async () => {
    const th = host({ ...SAMPLE_VAULT, [NOTE]: '| a | b |\n|---|---|\n| x | y |\n' });
    const m = await th.mount(NOTE);
    const outer = m.view();
    act(() => void focusCell(outer, 0, 1, 0, 'end'));
    expect(activeCellView(outer)?.state.doc.toString()).toBe('x');
    const e = createSampleEnv(th.ctx);
    await act(async () => void (await insertSampleReference(e, e.editTarget(), 'DNA-1;a|b')));
    const row = m.view().state.doc.toString().split('\n')[2];
    expect(row).toBe('| xDNA-1;a\\|b | y |');
    expect(row.split(/(?<!\\)\|/).length).toBe('| x | y |'.split('|').length);
  });

  // #543 (vendor 0.140.2 writeIntoCell): only the cell's text is read, so after an
  // aliased reference the new one needs a space, or it would join the alias.
  it('into an active cell after an aliased reference, puts a space before the reference', async () => {
    const th = host({ ...SAMPLE_VAULT, [NOTE]: '| a | b |\n|---|---|\n| DNA-2;pET | y |\n' });
    const m = await th.mount(NOTE);
    act(() => void focusCell(m.view(), 0, 1, 0, 'end'));
    expect(activeCellView(m.view())?.state.doc.toString()).toBe('DNA-2;pET');
    const e = createSampleEnv(th.ctx);
    await act(async () => void (await insertSampleReference(e, e.editTarget(), 'RNA-1;siKIF')));
    expect(m.view().state.doc.toString().split('\n')[2]).toBe('| DNA-2;pET RNA-1;siKIF | y |');
  });

  // #544: a dialog left the editor reporting the start of the note, which put the
  // reference in the properties.
  it('uses the cursor read before a dialog over the one the editor reports after it', async () => {
    const doc = '---\nstatus: planned\n---\n\n## Samples\nbefore\n';
    const { target, state } = makeTarget(doc, 0); // what the editor says once the dialog closed
    const saved = doc.indexOf('before') + 'before'.length;
    await insertSampleReference(env(), target, 'RNA-1;siKIF', saved);
    expect(state.text).toBe('---\nstatus: planned\n---\n\n## Samples\nbefore RNA-1;siKIF\n');
  });
});

describe('insert-experiment-samples-table', () => {
  it('inserts every Local sample plus Global samples the experiment uses, one undo step', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    await run(th);
    const doc = m.view().state.doc.toString();
    expect(doc).toContain('| DNA-1 | pUC | miniprep | Freezer A / B3 |');
    expect(doc).toContain('| Reagent-7 | Taq | polymerase |');
    expect(doc).not.toContain('Reagent-900'); // a catalog entry nobody uses is not a sample of the experiment
    expect(lastNote(th)).toContain(coreT('Inserted {0} sample(s).', '2'));
    act(() => void undo(m.view()));
    expect(m.view().state.doc.toString()).toBe(SAMPLE_VAULT[NOTE]);
  });

  it('existing table → Replace / Insert one more / Cancel', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    const tableCount = () => (m.view().state.doc.toString().match(/\| ID \| Alias \|/g) ?? []).length;
    await run(th);
    expect(tableCount()).toBe(1);
    expect(th.asked.pick).toHaveLength(0); // no table yet: no question

    th.answer.pick('replace');
    await run(th);
    expect(th.asked.pick).toHaveLength(1);
    expect(th.asked.pick[0].opts?.title).toBe(
      coreT('This note already has {0} sample list table(s). Replacing them loses rows and order changed by hand.', '1'),
    );
    expect(th.asked.pick[0].items.map((i) => i.value)).toEqual(['replace', 'add', 'cancel']);
    expect(tableCount()).toBe(1);
    expect(lastNote(th)).toContain(coreT('Replaced {0} sample list table(s) with the current samples ({1} sample(s)).', '1', '2'));

    th.answer.pick('add');
    await run(th);
    expect(tableCount()).toBe(2);

    const before = m.view().state.doc.toString();
    for (const answer of ['cancel', undefined]) {
      th.answer.pick(answer);
      await run(th);
      expect(m.view().state.doc.toString()).toBe(before);
    }
  });

  it('from a table cell the list goes below the table', async () => {
    const table = '| a |\n|---|\n| x |';
    const text = `${SAMPLE_VAULT[NOTE]}\n${table}\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: text });
    const m = await th.mount(NOTE);
    const outer = m.view();
    const tableFrom = text.indexOf(table);
    act(() => void focusCell(outer, tableFrom, 1, 0, 'end'));
    expect(activeCellView(outer)?.state.doc.toString()).toBe('x');
    await run(th);
    const doc = m.view().state.doc.toString();
    const end = tableFrom + table.length;
    expect(doc.slice(0, end)).toBe(text.slice(0, end)); // the table lines are unchanged
    expect(doc.slice(end).startsWith('\n\n| ID | Alias | Description | Location | Scope | Discarded |')).toBe(true);
  });

  it('from front matter the list goes at the end', async () => {
    const text = `---\ntags: pcr\n---\n${SAMPLE_VAULT[NOTE]}`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: text });
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ selection: { anchor: 0 } }));
    await run(th);
    const doc = m.view().state.doc.toString();
    expect(doc.startsWith(text)).toBe(true);
    expect(doc).toMatch(/\| Reagent-7 \| Taq \| polymerase \| {2}\| Global \| 2026-10-01 \|\n$/);
    expect(lastNote(th)).toContain(
      coreT('The cursor was in the properties or above the title, so the table is at the end of the note.'),
    );
  });

  it('unregistered references are named in the notice', async () => {
    const th = host({ ...SAMPLE_VAULT, [NOTE]: `${SAMPLE_VAULT[NOTE]}DNA-99\n` });
    await th.mount(NOTE);
    await run(th);
    expect(lastNote(th)).toContain('DNA-99');
    expect(lastNote(th)).toContain(
      coreT(
        "{0} sample reference(s) in this experiment's notes are not in the sample registry, so they are not in the table: {1}",
        '1',
        'DNA-99',
      ),
    );
  });

  it('Markdown outside the ID column is escaped', async () => {
    const registry = SAMPLE_VAULT[`${LOCAL}/DNA.json`].replace('Freezer A / B3', 'freezer #B3');
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: registry });
    const m = await th.mount(NOTE);
    await run(th);
    expect(m.view().state.doc.toString()).toContain('| freezer \\#B3 |');
  });

  it('the command is always listed and explains without a note', async () => {
    const th = host(SAMPLE_VAULT);
    await run(th);
    expect(th.notes.at(-1)!.message).toBe(coreT('Open a note to insert into.'));
    expect(commandById(CMD)!.available).toBeUndefined();
  });

  it('explains a note outside any experiment', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount('Home.md');
    await run(th);
    expect(lastNote(th)).toBe(coreT('Open a note of an experiment to list its samples.'));
    expect(m.view().state.doc.toString()).toBe(SAMPLE_VAULT['Home.md']);
  });

  it('says an experiment has no samples yet', async () => {
    const files = { 'labnote/070_Empty/README.labnote.md': '# empty\n', 'labnote/070_Empty/001_a.labnote.md': '# a\n' };
    const th = host(files);
    await th.mount('labnote/070_Empty/001_a.labnote.md');
    await run(th);
    expect(lastNote(th)).toBe(coreT('This experiment has no samples yet.'));
  });

  it("names the README when the experiment's sample tracking is off", async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount('labnote/062_Gel/001_run.labnote.md');
    await run(th);
    expect(lastNote(th)).toBe(coreT("Sample tracking is off for this experiment: its README sets sample_tracking: 'no'."));
    expect(m.view().state.doc.toString()).toBe(SAMPLE_VAULT['labnote/062_Gel/001_run.labnote.md']);
  });

  it('names the setting when sample tracking is off everywhere', async () => {
    const th = host(SAMPLE_VAULT, { sampleTracking: false });
    const m = await th.mount(NOTE);
    await run(th);
    expect(lastNote(th)).toBe(coreT('Sample tracking is turned off in {0}.', t('cmd.sampleSettings')));
    expect(m.view().state.doc.toString()).toBe(SAMPLE_VAULT[NOTE]);
  });
});

// #450: running the command again put a second table under the first without a word.
describe('insertExperimentSamplesTable with a table already there', () => {
  const FOLDER = 'labnote/001_Test/resources/labsamples';
  const DOC = 'labnote/001_Test/001_WD010_Design.labnote.md';
  const HEAD = '| ID | Alias | Description | Location | Scope | Discarded |\n| --- | --- | --- | --- | --- | --- |';
  const OLD_KO =
    '| ID | 별칭 | 설명 | 보관 위치 | 범위 | 폐기 |\n| --- | --- | --- | --- | --- | --- |\n| RNA-1 | old |  |  | 로컬 |  |\n| RNA-9 | 손으로 |  |  | 로컬 |  |';
  const FRESH = `${HEAD}\n| RNA-1 | siKIF | kd | Freezer-1 | Local |  |\n| RNA-2 | siX |  |  | Local |  |`;

  async function setUp(text: string, cursor = text.length, registry?: (raw: Record<string, Record<string, unknown>>) => void) {
    const th = host({ 'labnote/001_Test/README.labnote.md': '# Test\n', [DOC]: text });
    await upsertSampleRecord(th.host.fs, FOLDER, 'RNA', 'RNA-1', { alias: 'siKIF', description: 'kd', location: 'Freezer-1' });
    await upsertSampleRecord(th.host.fs, FOLDER, 'RNA', 'RNA-2', { alias: 'siX', description: null });
    if (registry) {
      const raw = JSON.parse(await th.host.fs.read(`${FOLDER}/RNA.json`));
      registry(raw);
      await th.host.fs.write(`${FOLDER}/RNA.json`, JSON.stringify(raw));
    }
    const m = await th.mount(DOC);
    act(() => m.view().dispatch({ selection: { anchor: cursor } }));
    const env = createSampleEnv(th.ctx);
    const text$ = () => m.view().state.doc.toString();
    const insert = async () => {
      let r = false;
      await act(async () => void (r = await insertExperimentSamplesTable(env)));
      return r;
    };
    return { th, m, text: text$, insert };
  }

  it('inserts without asking when the note has no sample list table', async () => {
    const { th, text, insert } = await setUp('## Samples\n');
    expect(await insert()).toBe(true);
    expect(th.asked.pick).toHaveLength(0);
    expect(text()).toBe(`## Samples\n\n${FRESH}\n`);
  });

  // #462, #458
  it('lists every description and a location emptied on discard', async () => {
    const { text, insert } = await setUp('## Samples\n', undefined, (raw) => {
      raw['RNA-1'].descriptions = ['kd2', 'kd'];
      raw['RNA-2'] = { ...raw['RNA-2'], discarded: '2026-10-19', discardedLocation: 'Box-3' };
    });
    await insert();
    expect(text()).toContain('| RNA-1 | siKIF | kd2; kd | Freezer-1 | Local |  |');
    expect(text()).toContain('| RNA-2 | siX |  | (emptied, was Box-3) | Local | 2026-10-19 |');
  });

  it('replaces every table with the current one, in the UI language, leaving the rest', async () => {
    const doc = `# A\n${OLD_KO}\n\nmiddle\n\n${HEAD}\n| RNA-1 | x |  |  | Local |  |\n\nend\n`;
    const { th, m, text, insert } = await setUp(doc, 0);
    th.answer.pick('replace');
    expect(await insert()).toBe(true);
    expect(text()).toBe(`# A\n${FRESH}\n\nmiddle\n\n${FRESH}\n\nend\n`);
    expect(m.view().state.selection.main.head).toBe(`# A\n${FRESH}\n`.length);
    expect(th.asked.pick[0].opts?.title).toContain('already has 2 sample list table(s)');
    act(() => void undo(m.view()));
    expect(text()).toBe(doc); // both tables in one undo step
  });

  it('adds one more like before when asked, below the table when the cursor is in its text', async () => {
    const doc = `# A\n${OLD_KO}\n\nafter\n`;
    const end = `# A\n${OLD_KO}`.length;
    const { th, text, insert } = await setUp(doc, doc.indexOf('old'));
    th.answer.pick('add');
    expect(await insert()).toBe(true);
    expect(text()).toBe(`${doc.slice(0, end)}\n\n${FRESH}\n${doc.slice(end)}`);
  });

  it('leaves the note alone when cancelled or closed', async () => {
    const doc = `# A\n${OLD_KO}\n`;
    for (const answer of ['cancel', undefined]) {
      const { th, text, insert } = await setUp(doc);
      th.answer.pick(answer);
      expect(await insert()).toBe(false);
      expect(text()).toBe(doc);
    }
  });

  // #450: the picker takes the focus, and a Source mode editor then reports the
  // cursor at the start of the note, so the table went above the title.
  it('inserts where the cursor was before the picker opened, not where it is after', async () => {
    const doc = `# A\n${OLD_KO}\n\nafter\n`;
    const end = `# A\n${OLD_KO}`.length;
    const { th, m, text, insert } = await setUp(doc, doc.indexOf('old'));
    th.answer.pick(() => {
      m.view().dispatch({ selection: { anchor: 0 } });
      return 'add';
    });
    expect(await insert()).toBe(true);
    expect(text()).toBe(`${doc.slice(0, end)}\n\n${FRESH}\n${doc.slice(end)}`);
  });
});
