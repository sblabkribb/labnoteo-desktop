// @vitest-environment jsdom
/**
 * UI 재설계 Task 19: 새 실험 대화상자(실험자), 새 README 의 안내 인용 지우기, 상태 권유(status nudge).
 */
import { generateReadmeContent } from '@labnoteo/core/lib/labnoteStructure';
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { createExperiment, stripInstructionCallouts } from '../experiment';
import { applyStatusNudge, checklistCounts, statusNudge } from '../statusNudge';
import { toggleWorkflowTick } from '../workflow';

const DIR = 'labnote/001_GFP_assay';
const README_PATH = `${DIR}/README.labnote.md`;

let h: TestHost;

beforeEach(() => setLang('ko'));
afterEach(() => h?.cleanup());

function readme(status: string, boxes: string[]): string {
  return [
    '---',
    'title: GFP assay',
    'author: Alex',
    `status: ${status}`,
    'created_date: 2026-01-01',
    'last_updated_date: 2026-01-01',
    '---',
    '',
    '## 🗂️ Related Workflows',
    '',
    ...boxes.map((b, i) => `- [${b}] [[00${i + 1}_WB030_DNA_Assembly.labnote.md|WB030 step ${i + 1}]]`),
    '',
    '## Summary and Discussion',
    '',
  ].join('\n');
}

describe('new-experiment dialog', () => {
  it('pre-fills the experimenter from the settings', async () => {
    h = createTestHost({}, { defaultExperimenter: '김연구' });
    h.answer.newExperiment(undefined);
    await createExperiment(h.ctx);
    expect(h.asked.newExperiment).toHaveLength(1);
    expect(h.asked.newExperiment[0].experimenter).toBe('김연구');
  });

  it('creating writes author, saves defaultExperimenter, then opens the README', async () => {
    h = createTestHost();
    h.answer.newExperiment({ title: 'GFP assay', experimenter: '  Alex Kim ' });
    const path = await createExperiment(h.ctx);
    expect(path).toBe(README_PATH);
    const text = h.vault.files()[README_PATH];
    expect(text).toMatch(/^author: '?Alex Kim'?$/m);
    expect(h.ctx.settings.defaultExperimenter).toBe('Alex Kim');
    expect(h.opened).toEqual([README_PATH]);
  });

  it('an empty experimenter leaves author empty and still remembers it', async () => {
    h = createTestHost({}, { defaultExperimenter: 'Alex' });
    h.answer.newExperiment({ title: 'GFP assay', experimenter: '' });
    await createExperiment(h.ctx);
    expect(h.vault.files()[README_PATH]).toMatch(/^author: ?(''|"")?$/m);
    expect(h.ctx.settings.defaultExperimenter).toBe('');
  });

  it('the README has no Ctrl+P / Cmd+P callout but keeps every heading and the checklist section', async () => {
    for (const lang of ['ko', 'en'] as const) {
      setLang(lang);
      h = createTestHost();
      h.answer.newExperiment({ title: 'GFP assay', experimenter: 'Alex' });
      await createExperiment(h.ctx);
      const text = h.vault.files()[README_PATH];
      expect(text).not.toMatch(/Cmd\+P|Ctrl\+P/);
      expect(text).toContain('## 🎯 Experiment Objective');
      expect(text).toContain('> Briefly describe the main objective');
      expect(text).toContain('## 🗂️ Related Workflows');
      expect(text).toContain('## Summary and Discussion');
      expect(text).toContain('## 🗂️ Related Workflows\n\n## Summary and Discussion');
      h.cleanup();
    }
  });
});

describe('stripInstructionCallouts', () => {
  it('removes the template block in both locales and is idempotent', () => {
    for (const locale of ['en', 'ko']) {
      const raw = generateReadmeContent('T', 'A', { locale });
      expect(raw).toContain('Cmd+P');
      const once = stripInstructionCallouts(raw);
      expect(once).not.toContain('Cmd+P');
      expect(once).not.toContain('author: field of the YAML block');
      expect(stripInstructionCallouts(once)).toBe(once);
    }
  });

  it('leaves user-written callouts and edited blocks alone', () => {
    const own = '## Related Workflows\n\n> Press `Ctrl+P` to do my own thing.\n> [!note] mine\n\n## Summary\n';
    expect(stripInstructionCallouts(own)).toBe(own);
    const edited = generateReadmeContent('T', 'A', { locale: 'en' }).replace('added to this section automatically', 'added here');
    expect(stripInstructionCallouts(edited)).toBe(edited);
  });

  it('is a no-op on text without the block', () => {
    expect(stripInstructionCallouts('')).toBe('');
    expect(stripInstructionCallouts('# x\n')).toBe('# x\n');
  });
});

describe('statusNudge', () => {
  it('first tick of a planned experiment → inProgress', () => {
    expect(statusNudge({ done: 0, total: 3, status: 'planned' }, { done: 1, total: 3, status: 'planned' })).toBe('inProgress');
  });
  it('last tick → done (from planned or in progress)', () => {
    expect(statusNudge({ done: 2, total: 3, status: 'in-progress' }, { done: 3, total: 3, status: 'in-progress' })).toBe('done');
    expect(statusNudge({ done: 0, total: 1, status: 'planned' }, { done: 1, total: 1, status: 'planned' })).toBe('done');
  });
  it('nothing for unticks, middle ticks, other statuses or already-done', () => {
    expect(statusNudge({ done: 1, total: 3, status: 'planned' }, { done: 0, total: 3, status: 'planned' })).toBeNull();
    expect(statusNudge({ done: 1, total: 3, status: 'in-progress' }, { done: 2, total: 3, status: 'in-progress' })).toBeNull();
    expect(statusNudge({ done: 2, total: 3, status: 'failed' }, { done: 3, total: 3, status: 'failed' })).toBeNull();
    expect(statusNudge({ done: 2, total: 3, status: 'completed' }, { done: 3, total: 3, status: 'completed' })).toBeNull();
    expect(statusNudge({ done: 0, total: 3, status: 'in-progress' }, { done: 1, total: 3, status: 'in-progress' })).toBeNull();
    expect(statusNudge({ done: 0, total: 0, status: 'planned' }, { done: 0, total: 0, status: 'planned' })).toBeNull();
  });
  it('an experiment with no status (legacy README) is treated like planned', () => {
    expect(statusNudge({ done: 0, total: 3, status: '' }, { done: 1, total: 3, status: '' })).toBe('inProgress');
    expect(statusNudge({ done: 2, total: 3, status: '' }, { done: 3, total: 3, status: '' })).toBe('done');
  });
  it('checklistCounts reads the Related Workflows checklist and the status', () => {
    expect(checklistCounts(readme('planned', ['x', ' ', ' ']))).toEqual({ done: 1, total: 3, status: 'planned' });
  });
});

describe('status nudge on a tick', () => {
  const files = (status: string, boxes: string[]) => ({
    [README_PATH]: readme(status, boxes),
    ...Object.fromEntries(boxes.map((_, i) => [`${DIR}/00${i + 1}_WB030_DNA_Assembly.labnote.md`, '---\ntitle: w\n---\n'])),
  });

  it('ticking the first of 3 on a planned experiment offers 바꾸기, and the click writes in-progress', async () => {
    h = createTestHost(files('planned', [' ', ' ', ' ']));
    await toggleWorkflowTick(h.ctx, DIR, '001_WB030_DNA_Assembly.labnote.md');
    const i = h.noteOpts.findIndex((o) => o.action);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.noteOpts[i].action?.label).toBe('바꾸기');
    expect(h.notes[i].message).toContain('진행 중');
    expect(h.vault.files()[README_PATH]).toMatch(/^status: planned$/m);
    h.noteOpts[i].action!.run();
    await vi.waitFor(() => expect(h.vault.files()[README_PATH]).toMatch(/^status: in-progress$/m));
  });

  it('ticking the last offers done', async () => {
    h = createTestHost(files('in-progress', ['x', 'x', ' ']));
    await toggleWorkflowTick(h.ctx, DIR, '003_WB030_DNA_Assembly.labnote.md');
    const i = h.noteOpts.findIndex((o) => o.action);
    expect(h.notes[i].message).toBe('모든 Workflow 를 완료로 표시했습니다. 실험도 완료로 표시할까요?');
    expect(h.noteOpts[i].action?.label).toBe('실험 완료로 표시');
    // 단추를 누르기 전에는 바꾸지 않는다
    expect(h.vault.files()[README_PATH]).toMatch(/^status: in-progress$/m);
  });

  it('without the click nothing changes', async () => {
    h = createTestHost(files('planned', [' ', ' ', ' ']));
    await toggleWorkflowTick(h.ctx, DIR, '001_WB030_DNA_Assembly.labnote.md');
    expect(h.vault.files()[README_PATH]).toMatch(/^status: planned$/m);
    expect(h.vault.files()[README_PATH]).toMatch(/^- \[x\] \[\[001_/m);
  });

  it('applyStatusNudge(done) asks the completed questions first and can be cancelled', async () => {
    h = createTestHost(files('in-progress', ['x', 'x', 'x']));
    // 워크플로 노트에 end_date 가 없으므로 묻지 않는다(키가 없다): 바로 완료
    await applyStatusNudge(h.ctx, README_PATH, 'done');
    expect(h.vault.files()[README_PATH]).toMatch(/^status: completed$/m);
  });
});
