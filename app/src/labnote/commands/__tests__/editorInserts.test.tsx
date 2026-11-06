// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { undo } from '@codemirror/commands';
import { issueSentenceRange, parseIssueMarkers } from '@labnoteo/core';
import { insertWorkflowChecklistEntries } from '@labnoteo/core/lib/workflowStructure';
import { activeCellView, focusCell } from '../../../editor/table/cellEditor';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { coreT } from '../../i18n';
import { ISSUE_SYNC_WORKFLOW_PATH } from '../../port/issueAutomation';
import { insertDate, insertIssueMarker, resetIssueHintForTest } from '../editorInserts';
import { clearCommandsForTest, commandById } from '../registry';
import { registerAllCommands } from '../registerAll';
import { runCommand } from '../runCommand';

const DIR = 'labnote/001_단백질_발현';
const README_PATH = `${DIR}/README.labnote.md`;
const WF_PATH = `${DIR}/001_WB010_Protein_Expression.labnote.md`;
const TABLE = '| 시료 | 부피 |\n| --- | --- |\n| A | 10 |';
const NOW = () => '2026-11-06';

const README = [
  '---',
  'title: 단백질 발현',
  'author:',
  'status: in-progress',
  'end_date:',
  '---',
  '',
  '## Purpose',
  '',
  '발현 조건을 정한다. 온도가 문제다.',
  '',
  TABLE,
  '',
  '```',
  'code here',
  '```',
  '',
  '## 🗂️ Related Workflows',
  '',
  '',
].join('\n');

const META = ['### [UHW010 Mixing]', '', '#### Meta', "- Start_date: '2026-12-01'", '- End_date:', '', '본문', ''].join('\n');

let h: TestHost;

beforeEach(() => {
  setLang('ko');
  resetIssueHintForTest();
});

afterEach(() => {
  for (const n of h?.notes ?? []) expect(n.message).toMatch(/[가-힣]/);
  h?.cleanup();
});

async function open(path: string, text: string, extra: Record<string, string> = {}) {
  h = createTestHost({ [path]: text, ...extra });
  return h.mount(path);
}

type Mounted = Awaited<ReturnType<typeof open>>;

/** 커서를 `needle` 앞(+plus)에 두거나, `len` 을 주면 그만큼 고른다. */
function select(m: Mounted, needle: string, plus = 0, len = 0) {
  const v = m.view();
  const at = v.state.doc.toString().indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  act(() => v.dispatch({ selection: { anchor: at + plus, head: at + plus + len } }));
}

const docOf = (m: Mounted) => m.view().state.doc.toString();

function undoRestores(m: Mounted, original: string) {
  act(() => void undo(m.view()));
  expect(docOf(m)).toBe(original);
}

describe('insert-date', () => {
  it('date in body at cursor; the caret ends after it; one undo removes it', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가', 0);
    expect(insertDate(h.ctx, NOW)).toBe(true);
    expect(docOf(m)).toContain('2026-11-06온도가');
    expect(m.view().state.selection.main.head).toBe(docOf(m).indexOf('온도가'));
    expect(h.notes).toEqual([]);
    undoRestores(m, README);
  });

  it('with a selection, the date replaces it', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가', 0, 3);
    expect(insertDate(h.ctx, NOW)).toBe(true);
    expect(docOf(m)).toContain('2026-11-06 문제다.');
    expect(docOf(m)).not.toContain('온도가');
    undoRestores(m, README);
  });

  it('an empty end_date in front matter is filled', async () => {
    const m = await open(README_PATH, README);
    select(m, 'end_date:', 9);
    expect(insertDate(h.ctx, NOW)).toBe(true);
    expect(docOf(m).split('\n')[4]).toMatch(/^end_date: '?2026-11-06'?$/);
    undoRestores(m, README);
  });

  it('a non-date front-matter key is refused with the notDateKey text', async () => {
    const m = await open(README_PATH, README);
    select(m, 'author:', 7);
    expect(insertDate(h.ctx, NOW)).toBe(false);
    expect(h.notes).toEqual([
      {
        kind: 'warn',
        message: coreT(
          '{0} is not a date field, so no date was put there. Run this on an empty date line such as end_date, or in the body.',
          'author',
        ),
      },
    ]);
    expect(docOf(m)).toBe(README);
  });

  it('a filled Meta Start_date is refused with the app metaDateFilled text (no 📅 picker mention)', async () => {
    const m = await open(WF_PATH, META);
    select(m, '2026-12-01', 2);
    expect(insertDate(h.ctx, NOW)).toBe(false);
    expect(h.notes).toEqual([{ kind: 'warn', message: t('insertDate.metaDateFilled') }]);
    expect(h.notes[0].message).not.toContain('📅');
    expect(docOf(m)).toBe(META);
  });

  it('End_date earlier than Start_date warns', async () => {
    const m = await open(WF_PATH, META);
    select(m, '- End_date:', 11);
    expect(insertDate(h.ctx, NOW)).toBe(true);
    expect(docOf(m)).toContain("- End_date: '2026-11-06'");
    expect(h.notes).toEqual([
      { kind: 'warn', message: coreT('End_date {0} is earlier than Start_date {1}.', '2026-11-06', '2026-12-01') },
    ]);
    undoRestores(m, META);
  });

  it('in a freshly focused table cell (no keystroke yet) the date lands at the cell caret, the table stays one table, no stray newline, the nested caret ends after the date, and one undo removes it', async () => {
    const m = await open(README_PATH, README);
    const outer = m.view();
    const tableFrom = docOf(m).indexOf(TABLE);
    act(() => void focusCell(outer, tableFrom, 1, 1, 'end'));
    const cell = activeCellView(outer);
    expect(cell).toBeTruthy();
    expect(cell!.state.doc.toString()).toBe('10');
    act(() => void insertDate(h.ctx, NOW));
    const doc = docOf(m);
    expect(doc).toContain('| A | 102026-11-06 |');
    expect(doc).toBe(README.replace('| A | 10 |', '| A | 102026-11-06 |'));
    const nested = activeCellView(outer)!;
    expect(nested.state.doc.toString()).toBe('102026-11-06');
    expect(nested.state.selection.main.head).toBe('102026-11-06'.length);
    expect(h.notes).toEqual([]);
    undoRestores(m, README);
  });

  it('a CRLF note stays CRLF', async () => {
    const crlf = README.replace(/\n/g, '\r\n');
    const m = await open(README_PATH, crlf);
    select(m, 'end_date:', 9);
    expect(insertDate(h.ctx, NOW)).toBe(true);
    select(m, '온도가', 0);
    expect(insertDate(h.ctx, NOW)).toBe(true);
    await act(async () => void (await m.ref.current!.flush()));
    const saved = h.vault.files()[README_PATH];
    expect(saved).not.toMatch(/[^\r]\n/);
    expect(saved).toContain('2026-11-06온도가');
    expect(saved).toMatch(/\r\nend_date: '?2026-11-06'?\r\n/);
  });

  it('with no note open, it says to open a note (app override text)', async () => {
    h = createTestHost({ [README_PATH]: README });
    expect(insertDate(h.ctx, NOW)).toBe(false);
    expect(h.notes).toEqual([{ kind: 'info', message: t('insertDate.noNote') }]);
  });
});

describe('insert-issue-marker', () => {
  it('issue marker from a selection: one undo removes it', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가 문제다.', 0, '온도가 문제다.'.length);
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(true);
    const markers = parseIssueMarkers(docOf(m)).markers;
    expect(markers).toHaveLength(1);
    expect(markers[0].title).toBe('온도가 문제다.');
    expect(h.asked.prompt).toHaveLength(0);
    undoRestores(m, README);
  });

  it('issue marker with no selection prompts, prefilled with the sentence', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가', 1);
    h.answer.prompt((o) => o.value);
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(true);
    expect(h.asked.prompt).toHaveLength(1);
    const sentence = issueSentenceRange(README, README.indexOf('온도가') + 1)!.text;
    expect(sentence).toContain('온도가 문제다.');
    expect(h.asked.prompt[0].value).toBe(sentence);
    expect(h.asked.prompt[0].title).toBe(coreT('Issue topic sentence'));
    const markers = parseIssueMarkers(docOf(m)).markers;
    expect(markers.map((x) => x.title)).toEqual([sentence]);
    undoRestores(m, README);
  });

  it('re-reads the note after the prompt: typing during the prompt is kept', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가', 1);
    h.answer.prompt(() => {
      m.view().dispatch({ changes: { from: docOf(m).length, insert: '추가' } });
      return '새 주제';
    });
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(true);
    expect(docOf(m).endsWith('추가')).toBe(true);
    expect(parseIssueMarkers(docOf(m)).markers.map((x) => x.title)).toEqual(['새 주제']);
  });

  it('a cancelled prompt inserts nothing', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가', 1);
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(false);
    expect(docOf(m)).toBe(README);
  });

  it.each([
    ['table', '| A |', 2, 'Issue markers cannot go inside a table. Run this on a line below the table.'],
    ['front matter', 'status:', 2, 'Issue markers cannot go in the front matter. Run this in the note body.'],
    ['code block', 'code here', 2, 'Issue markers inside a code block open no issue. Run this on a line outside the code block.'],
  ])('refused inside a %s, with the plugin text', async (_where, needle, plus, key) => {
    const m = await open(README_PATH, README);
    select(m, needle, plus);
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(false);
    expect(h.notes).toEqual([{ kind: 'warn', message: coreT(key) }]);
    expect(h.asked.prompt).toHaveLength(0);
    expect(docOf(m)).toBe(README);
  });

  it('refused outside an experiment folder', async () => {
    const m = await open('notes/memo.md', '메모 한 줄.\n');
    select(m, '메모', 0, 2);
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(false);
    expect(h.notes).toEqual([
      {
        kind: 'warn',
        message: coreT(
          'Markers in this note open no issue: only the README and workflow notes (.labnote.md) directly in an experiment folder are read. Put the marker in one of those.',
        ),
      },
    ]);
    expect(docOf(m)).toBe('메모 한 줄.\n');
  });

  it('README checklist line: the marker goes after the link', async () => {
    const readme = insertWorkflowChecklistEntries(README, [
      { fileName: '001_WB010_Protein_Expression.labnote.md', title: '단백질 발현 워크플로', done: false },
    ]);
    const entry = readme.split('\n').find((l) => l.includes('001_WB010_Protein_Expression'))!;
    expect(entry).toBeDefined();
    const m = await open(README_PATH, readme);
    select(m, entry, 2);
    h.answer.prompt((o) => o.value);
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(true);
    expect(h.asked.prompt[0].value).toBe('단백질 발현 워크플로');
    const line = docOf(m).split('\n').find((l) => l.includes('001_WB010_Protein_Expression'))!;
    expect(line.startsWith(entry)).toBe(true);
    expect(parseIssueMarkers(line).markers.map((x) => x.title)).toEqual(['단백질 발현 워크플로']);
  });

  it('with no note open, it says to open a note (app override text)', async () => {
    h = createTestHost({ [README_PATH]: README });
    expect(await insertIssueMarker(h.ctx)).toBe(false);
    expect(h.notes).toEqual([{ kind: 'info', message: t('issueMarker.noNote') }]);
  });

  it('warns on a topic over MAX_ISSUE_TOPIC characters', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가', 1);
    const long = '가'.repeat(300);
    h.answer.prompt(long);
    expect(await act(() => insertIssueMarker(h.ctx))).toBe(true);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].kind).toBe('warn');
    expect(h.notes[0].message).toContain('300');
  });

  it('without the automation, no hint is shown (never the "Setup research automation" variant)', async () => {
    const m = await open(README_PATH, README);
    select(m, '온도가 문제다.', 0, '온도가 문제다.'.length);
    await act(() => insertIssueMarker(h.ctx));
    expect(h.notes).toEqual([]);
  });

  it('with the automation but no git repository, the hint is shown once per session', async () => {
    const m = await open(README_PATH, README, { [ISSUE_SYNC_WORKFLOW_PATH]: 'name: x\n' });
    select(m, '발현 조건을 정한다.', 0, '발현 조건을 정한다.'.length);
    await act(() => insertIssueMarker(h.ctx));
    expect(h.notes).toEqual([{ kind: 'info', message: expect.stringContaining('.labnoteo/SETUP.md') }]);
    select(m, 'Related Workflows', 0, 'Related Workflows'.length);
    await act(() => insertIssueMarker(h.ctx));
    expect(h.notes).toHaveLength(1);
    expect(parseIssueMarkers(docOf(m)).markers).toHaveLength(2);
  });
});

describe('editor inserts while busy', () => {
  it('while busy (kept conflict), nothing is inserted and command.noteBusy is shown', async () => {
    const user = userEvent.setup();
    const m = await open(README_PATH, README);
    await m.type('!');
    const mine = docOf(m);
    const theirs = `${README}바깥 변경\n`;
    await h.vault.mem.write(README_PATH, theirs);
    await act(() => h.vault.emitChange(README_PATH, 'modified'));
    await user.click(await screen.findByRole('button', { name: '그대로 두기' }));

    expect(insertDate(h.ctx, NOW)).toBe(false);
    await act(() => runCommand(h.ctx, () => insertIssueMarker(h.ctx)));
    expect(h.notes).toEqual([
      { kind: 'warn', message: t('command.noteBusy') },
      { kind: 'warn', message: t('command.noteBusy') },
    ]);
    expect(h.asked.prompt).toHaveLength(0);
    expect(docOf(m)).toBe(mine);
    expect(h.vault.files()[README_PATH]).toBe(theirs);
  });
});

it('registerAllCommands registers insert-date, insert-datetime and insert-issue-marker', () => {
  h = createTestHost();
  clearCommandsForTest();
  registerAllCommands();
  expect(commandById('insert-date')?.nameKey).toBe('Insert date');
  expect(commandById('insert-datetime')?.nameKey).toBe('Insert date and time');
  expect(commandById('insert-issue-marker')?.nameKey).toBe('Insert issue marker');
  clearCommandsForTest();
});
