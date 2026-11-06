// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { undo } from '@codemirror/commands';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { clearCommandsForTest, commandById } from '../registry';
import { registerAllCommands } from '../registerAll';
import { runCommand } from '../runCommand';
import { changeExperimentStatus, createExperiment, retryFromActive, toggleDiscussionFlag } from '../experiment';

const DIR = 'labnote/001_실험_1차';
const README_PATH = `${DIR}/README.labnote.md`;
const TODAY = getSeoulDateString();

/** 실험 README. `fm` 은 front matter 에 더할 줄들, `checklist` 는 Related Workflows 의 항목들. */
function readme(status: string, fm = '', checklist = ''): string {
  return [
    '---',
    'title: 실험 1차',
    "author: '김연구'",
    'project: 단백질',
    `status: ${status}`,
    'created_date: 2026-01-01',
    'last_updated_date: 2026-01-01',
    `${fm}---`,
    '',
    '## 🗂️ Related Workflows',
    '',
    `${checklist}`,
    '## Summary and Discussion',
    '',
  ].join('\n');
}

let h: TestHost;

beforeEach(() => {
  setLang('ko');
});

afterEach(() => {
  // 한국어 화면에서는 모든 알림이 한국어다(영어 키가 그대로 나오지 않는다)
  for (const n of h?.notes ?? []) expect(n.message).toMatch(/[가-힣]/);
  h?.cleanup();
});

const writes = () => h.vault.log.filter((c) => ['vault_write', 'vault_modify', 'vault_mkdir'].includes(c.cmd));

describe('create-experiment', () => {
  it('create-experiment makes labnote/001_Title with images, resources and README, opens it', async () => {
    h = createTestHost();
    h.answer.prompt('실험 1차');
    await createExperiment(h.ctx);
    expect(await h.host.fs.exists(`${DIR}/images`)).toBe(true);
    expect(await h.host.fs.exists(`${DIR}/resources`)).toBe(true);
    const text = h.vault.files()[README_PATH];
    expect(text).toMatch(/^---\ntitle: 실험 1차\n/);
    expect(h.refreshes()).toBe(1);
    expect(h.opened).toEqual([README_PATH]);
    expect(h.notes).toEqual([{ kind: 'info', message: '실험이 생성되었습니다: 001_실험_1차' }]);
  });

  it('numbering skips ###_ folders nested one level down', async () => {
    h = createTestHost({
      'labnote/001_a/README.labnote.md': readme('planned'),
      'labnote/group/007_moved/README.labnote.md': readme('planned'),
    });
    h.answer.prompt('새 실험');
    const path = await createExperiment(h.ctx);
    expect(path).toBe('labnote/008_새_실험/README.labnote.md');
    expect(h.vault.files()[path!]).toBeDefined();
  });

  it('the title hint warns on a same-title experiment', async () => {
    h = createTestHost({ 'labnote/001_PCR/README.labnote.md': readme('planned').replace('title: 실험 1차', 'title: PCR') });
    let hint: { text: string; warn?: boolean } | undefined;
    h.answer.prompt((opts) => {
      hint = opts.hint?.('pcr');
      return undefined;
    });
    await createExperiment(h.ctx);
    expect(hint?.warn).toBe(true);
    expect(hint?.text).toContain('001_PCR');
    expect(hint?.text).toMatch(/[가-힣]/);
  });

  it('cancel writes nothing', async () => {
    h = createTestHost();
    h.answer.prompt(undefined);
    expect(await createExperiment(h.ctx)).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.notes).toEqual([]);
  });
});

describe('retry-experiment', () => {
  it("retry of '실험 1차' proposes '실험 2차' and copies author/project and retry_of", async () => {
    h = createTestHost({ [README_PATH]: readme('failed') });
    h.setActive(README_PATH);
    let proposed: string | undefined;
    h.answer.prompt((opts) => (proposed = opts.value));
    await retryFromActive(h.ctx);
    expect(proposed).toBe('실험 2차');
    const made = h.vault.files()['labnote/002_실험_2차/README.labnote.md'];
    expect(made).toMatch(/^author: '?김연구'?$/m);
    expect(made).toMatch(/^project: 단백질$/m);
    expect(made).toContain("retry_of: '[[labnote/001_실험_1차/README.labnote|001]]'");
    expect(h.opened).toEqual(['labnote/002_실험_2차/README.labnote.md']);
  });

  it('retry on an in-progress experiment explains and does nothing', async () => {
    h = createTestHost({ [README_PATH]: readme('in-progress') });
    h.setActive(README_PATH);
    await retryFromActive(h.ctx);
    expect(h.asked.prompt).toEqual([]);
    expect(writes()).toEqual([]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].message).toContain('001_실험_1차');
    expect(h.notes[0].message).toContain('in-progress');
  });

  it('with no lab note open it says to open one', async () => {
    h = createTestHost();
    await retryFromActive(h.ctx);
    expect(h.notes).toEqual([{ kind: 'warn', message: '먼저 랩노트 파일을 여세요.' }]);
  });
});

describe('change-experiment-status', () => {
  it('status picker opens on the current value and writes only the status line plus last_updated_date', async () => {
    const before = readme('in-progress', '# 손으로 적은 주석\n');
    h = createTestHost({ [README_PATH]: before });
    h.setActive(README_PATH);
    h.answer.pick((_items, opts) => {
      expect(opts?.selected).toBe('in-progress');
      return 'failed';
    });
    await changeExperimentStatus(h.ctx);
    expect(h.vault.files()[README_PATH]).toBe(
      before.replace('status: in-progress', 'status: failed').replace('last_updated_date: 2026-01-01', `last_updated_date: ${TODAY}`),
    );
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].kind).toBe('info');
  });

  it('without autoUpdateLastUpdated only the status line changes', async () => {
    const before = readme('in-progress');
    h = createTestHost({ [README_PATH]: before }, { autoUpdateLastUpdated: false });
    h.setActive(README_PATH);
    h.answer.pick('failed');
    await changeExperimentStatus(h.ctx);
    expect(h.vault.files()[README_PATH]).toBe(before.replace('status: in-progress', 'status: failed'));
  });

  it('completed with unchecked workflows asks to confirm; declining writes nothing', async () => {
    const before = readme('in-progress', '', '- [ ] [[001_PCR]]\n');
    h = createTestHost({ [README_PATH]: before });
    h.setActive(README_PATH);
    h.answer.pick('completed');
    h.answer.confirm(false);
    await changeExperimentStatus(h.ctx);
    expect(h.asked.confirm).toHaveLength(1);
    expect(h.asked.confirm[0].message).toMatch(/[가-힣]/);
    expect(h.vault.files()[README_PATH]).toBe(before);
    expect(h.vault.log.filter((c) => c.cmd === 'vault_modify')).toEqual([]);
  });

  it('completed with discuss on offers to clear it', async () => {
    const before = readme('in-progress', 'discuss: true\n', '- [x] [[001_PCR]]\n');
    h = createTestHost({ [README_PATH]: before, [`${DIR}/001_PCR.md`]: '---\nend_date: 2026-01-02\n---\n' });
    h.setActive(README_PATH);
    h.answer.pick('completed', (items: Array<{ value: unknown }>) => {
      expect(items.map((i) => i.value)).toEqual(['clear', 'keep', 'cancel']);
      return 'clear';
    });
    await changeExperimentStatus(h.ctx);
    const after = h.vault.files()[README_PATH];
    expect(after).toContain('status: completed');
    expect(after).not.toContain('discuss');
    expect(h.notes[0].message).toContain('논의 표시를 해제했습니다.');
  });

  it('YAML parse error refuses and names the file', async () => {
    const before = readme('in-progress').replace('title: 실험 1차', 'title: EXP: 3rd try');
    h = createTestHost({ [README_PATH]: before });
    h.setActive(README_PATH);
    await changeExperimentStatus(h.ctx);
    expect(h.asked.pick).toEqual([]);
    expect(h.vault.files()[README_PATH]).toBe(before);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].kind).toBe('warn');
    expect(h.notes[0].message).toContain(README_PATH);
  });

  it("from the workflow panel (experimentDir given) with another note open, it names that experiment and not 'this note'", async () => {
    h = createTestHost({ [README_PATH]: readme('planned'), 'labnote/002_b/README.labnote.md': readme('planned') });
    h.setActive('labnote/002_b/README.labnote.md');
    h.answer.pick('in-progress');
    await changeExperimentStatus(h.ctx, DIR);
    expect(h.vault.files()[README_PATH]).toContain('status: in-progress');
    expect(h.vault.files()['labnote/002_b/README.labnote.md']).toContain('status: planned');
  });

  it("with automation 'none' the message has no 'Setup research automation'", async () => {
    h = createTestHost({ [README_PATH]: readme('in-progress') });
    h.setActive(README_PATH);
    h.answer.pick('needs-review');
    await changeExperimentStatus(h.ctx);
    expect(h.vault.files()[README_PATH]).toContain('status: needs-review');
    expect(h.notes[0].message).not.toContain('연구노트 자동화 설정');
    expect(h.notes[0].message).not.toContain('Setup research automation');
  });

  it('the status command sees unsaved typing', async () => {
    const before = readme('in-progress');
    h = createTestHost({ [README_PATH]: before });
    const m = await h.mount(README_PATH);
    // 사용자가 저장하지 않고 status 를 completed 로 고쳐 쓰고, 끝에 메모를 더했다
    const at = before.indexOf('in-progress');
    await act(async () => {
      m.view().dispatch({ changes: { from: at, to: at + 'in-progress'.length, insert: 'completed' }, userEvent: 'input.type' });
    });
    await m.type('손으로 쓴 메모\n');
    expect(h.vault.files()[README_PATH]).toBe(before); // 아직 저장하지 않았다
    h.answer.pick((_items, opts) => {
      expect(opts?.selected).toBe('completed');
      return 'failed';
    });
    await act(() => changeExperimentStatus(h.ctx));
    const expected = `${before.replace('last_updated_date: 2026-01-01', `last_updated_date: ${TODAY}`).replace('status: in-progress', 'status: failed')}손으로 쓴 메모\n`;
    expect(m.view().state.doc.toString()).toBe(expected);
    expect(h.vault.files()[README_PATH]).toBe(expected);
  });
});

describe('toggle-discussion-flag', () => {
  it('toggle sets discuss: true then removes the key', async () => {
    const before = readme('in-progress');
    h = createTestHost({ [README_PATH]: before }, { autoUpdateLastUpdated: false });
    h.setActive(README_PATH);
    await toggleDiscussionFlag(h.ctx);
    expect(h.vault.files()[README_PATH]).toMatch(/^discuss: true$/m);
    await toggleDiscussionFlag(h.ctx);
    expect(h.vault.files()[README_PATH]).toBe(before);
    expect(h.notes.map((n) => n.message)).toEqual(['논의 표시를 설정했습니다.', '논의 표시를 해제했습니다.']);
  });

  it("with automation 'none' the message has no 'Setup research automation'; 'no-git' keeps the plugin text", async () => {
    h = createTestHost({ [README_PATH]: readme('in-progress') });
    h.setActive(README_PATH);
    await toggleDiscussionFlag(h.ctx);
    expect(h.notes[0].message).not.toContain('연구노트 자동화 설정');
    expect(h.notes[0].message).not.toContain('Setup research automation');

    h.cleanup();
    h = createTestHost({ [README_PATH]: readme('in-progress'), '.github/workflows/experiment-issues.yml': 'on: push\n' });
    h.setActive(README_PATH);
    await toggleDiscussionFlag(h.ctx);
    expect(h.notes[0].message).toContain('.labnoteo/SETUP.md');
  });

  it("run from another note, it says it changed that experiment's README", async () => {
    h = createTestHost({ [README_PATH]: readme('in-progress'), [`${DIR}/001_PCR.md`]: 'x\n' });
    h.setActive(`${DIR}/001_PCR.md`);
    await toggleDiscussionFlag(h.ctx);
    expect(h.vault.files()[README_PATH]).toMatch(/^discuss: true$/m);
    expect(h.notes[0].message).toContain('001_실험_1차');
    expect(h.notes[0].message).toContain('README');
  });

  it('a README open and dirty in the editor receives the discussion flag in its buffer, as one undo step', async () => {
    const before = readme('in-progress');
    h = createTestHost({ [README_PATH]: before }, { autoUpdateLastUpdated: false });
    const m = await h.mount(README_PATH);
    await m.type('저장 안 한 줄\n');
    await act(() => toggleDiscussionFlag(h.ctx));
    const flagged = m.view().state.doc.toString();
    expect(flagged).toMatch(/^discuss: true$/m);
    expect(flagged.endsWith('저장 안 한 줄\n')).toBe(true);
    expect(h.vault.files()[README_PATH]).toBe(flagged);
    act(() => void undo(m.view()));
    expect(m.view().state.doc.toString()).toBe(`${before}저장 안 한 줄\n`);
  });

  it('a README whose conflict was kept refuses with command.noteBusy and writes nothing', async () => {
    const user = userEvent.setup();
    const theirs = readme('planned');
    h = createTestHost({ [README_PATH]: readme('in-progress') });
    const m = await h.mount(README_PATH);
    await m.type('!');
    await h.vault.mem.write(README_PATH, theirs);
    await act(() => h.vault.emitChange(README_PATH, 'modified'));
    await user.click(await screen.findByRole('button', { name: '그대로 두기' }));
    const modifiesBefore = h.vault.log.filter((c) => c.cmd === 'vault_modify').length;
    await act(() => runCommand(h.ctx, () => toggleDiscussionFlag(h.ctx)));
    expect(h.notes).toEqual([{ kind: 'warn', message: t('command.noteBusy') }]);
    expect(h.vault.files()[README_PATH]).toBe(theirs);
    expect(h.vault.log.filter((c) => c.cmd === 'vault_modify').length).toBe(modifiesBefore);
    expect(m.view().state.doc.toString()).not.toContain('discuss');
  });
});

const BOM = String.fromCharCode(0xfeff);
/** Windows 에서 만든 README: UTF-8 BOM 과 CRLF. */
const windows = (text: string) => `${BOM}${text.replace(/\n/g, '\r\n')}`;

describe('README with a BOM and CRLF line endings', () => {
  it('toggle-discussion-flag clears discuss: true and keeps the BOM and CRLF', async () => {
    const plain = readme('in-progress');
    h = createTestHost({ [README_PATH]: windows(readme('in-progress', 'discuss: true\n')) }, { autoUpdateLastUpdated: false });
    h.setActive(README_PATH);
    await toggleDiscussionFlag(h.ctx);
    expect(h.vault.files()[README_PATH]).toBe(windows(plain));
    expect(h.notes.map((n) => n.message)).toEqual(['논의 표시를 해제했습니다.']);
  });

  it('retry-experiment accepts a failed experiment and copies author/project', async () => {
    h = createTestHost({ [README_PATH]: windows(readme('failed')) });
    h.setActive(README_PATH);
    let proposed: string | undefined;
    h.answer.prompt((opts) => (proposed = opts.value));
    await retryFromActive(h.ctx);
    expect(proposed).toBe('실험 2차');
    const made = h.vault.files()['labnote/002_실험_2차/README.labnote.md'];
    expect(made).toBeDefined();
    expect(made).toMatch(/^author: '?김연구'?$/m);
    expect(made).toMatch(/^project: 단백질$/m);
    expect(made.startsWith(BOM)).toBe(false);
    expect(made.includes('\r')).toBe(false);
  });

  it('change-experiment-status shows the current status and writes back with the BOM and CRLF', async () => {
    h = createTestHost({ [README_PATH]: windows(readme('in-progress')) }, { autoUpdateLastUpdated: false });
    h.setActive(README_PATH);
    h.answer.pick((items: Array<{ value: unknown; description?: string }>, opts) => {
      expect(opts?.selected).toBe('in-progress');
      expect(items.find((i) => i.value === 'in-progress')?.description).toBe(h.host.t('current'));
      return 'failed';
    });
    await changeExperimentStatus(h.ctx);
    expect(h.vault.files()[README_PATH]).toBe(windows(readme('failed')));
    expect(h.notes[0].message).toContain('in-progress → failed');
  });
});

describe('path comparison folds case (NTFS)', () => {
  it('the README open under another letter case is "this note"', async () => {
    h = createTestHost({ [README_PATH]: readme('in-progress') }, { autoUpdateLastUpdated: false });
    h.setActive(README_PATH);
    await toggleDiscussionFlag(h.ctx);
    const exact = h.notes[0].message;
    h.cleanup();
    h = createTestHost({ [README_PATH]: readme('in-progress') }, { autoUpdateLastUpdated: false });
    h.setActive(`${DIR}/readme.LABNOTE.md`);
    await toggleDiscussionFlag(h.ctx);
    expect(h.notes[0].message).toBe(exact);

    h.cleanup();
    h = createTestHost({ [README_PATH]: readme('planned') }, { autoUpdateLastUpdated: false });
    h.setActive(`${DIR}/readme.LABNOTE.md`);
    h.answer.pick('in-progress');
    await changeExperimentStatus(h.ctx, DIR);
    expect(h.notes[0].message).not.toContain('README');
  });
});

describe('registration', () => {
  it('registerAllCommands registers the four experiment commands', () => {
    h = createTestHost();
    clearCommandsForTest();
    registerAllCommands();
    expect(['create-experiment', 'retry-experiment', 'change-experiment-status', 'toggle-discussion-flag'].map((id) => commandById(id)?.nameKey)).toEqual([
      'Create experiment',
      'Retry this experiment',
      'Change experiment status',
      'Toggle discussion flag',
    ]);
    clearCommandsForTest();
  });
});
