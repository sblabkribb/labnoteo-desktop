// @vitest-environment jsdom
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { syncWorkflowChecklist } from '../syncChecklist';

const DIR = 'labnote/001_단백질_발현';
const README_PATH = `${DIR}/README.labnote.md`;
const TODAY = getSeoulDateString();
const KEPT = '001_WD010_General_Design_of_Experiment.labnote.md';
const MOVED = '002_WB010_Oligo_Assembly.labnote.md';

function readme(checklist: string, section = true): string {
  return [
    '---',
    'title: 단백질 발현',
    "author: '김연구'",
    'status: in-progress',
    'last_updated_date: 2026-01-01',
    '---',
    '',
    ...(section ? ['## 🗂️ Related Workflows', '', checklist] : []),
    '## Summary and Discussion',
    '',
  ].join('\n');
}

const entry = (file: string, label: string) => `- [ ] [[${file.slice(0, -'.md'.length)}|${label}]]\n`;
const workflowNote = (title: string) => `---\ntitle: ${title}\n---\n\n## [WB010 DNA Oligomer Assembly] x\n`;

let h: TestHost;

beforeEach(() => setLang('ko'));

afterEach(() => {
  for (const n of h?.notes ?? []) expect(n.message).toMatch(/[가-힣]/);
  h?.cleanup();
});

describe('sync-workflow-checklist (add-only)', () => {
  it('sync-workflow-checklist adds a moved-in workflow note, keeps existing entries, and reports partial when an entry is stale', async () => {
    const stale = entry('009_WD020_Gone.labnote.md', 'WD020 Gone');
    const kept = entry(KEPT, 'WD010 General Design of Experiment');
    h = createTestHost({
      [README_PATH]: readme(`${kept}${stale}`),
      [`${DIR}/${KEPT}`]: '---\ntitle: WD010 General Design of Experiment\n---\n',
      [`${DIR}/${MOVED}`]: workflowNote('WB010 Oligo Assembly'),
    });
    h.setActive(README_PATH);
    await syncWorkflowChecklist(h.ctx);
    const text = h.vault.files()[README_PATH];
    expect(text).toContain(kept);
    expect(text).toContain(stale); // 지우지 않는다: 그 정리는 뒤의 하위 프로젝트
    expect(text).toContain(`- [ ] [WB010 Oligo Assembly](./${MOVED})`);
    expect(text).toContain(`last_updated_date: ${TODAY}`);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].kind).toBe('info');
    expect(h.notes[0].message).toBe(
      `${h.host.t('Workflow checklist updated: {0} added, {1} removed.', '1', '0')} ${t('syncChecklist.partial')}`,
    );
  });

  it('a checklist that already matches says so and writes nothing', async () => {
    const before = readme(entry(KEPT, 'WD010 General Design of Experiment'));
    h = createTestHost({
      [README_PATH]: before,
      [`${DIR}/${KEPT}`]: '---\ntitle: WD010 General Design of Experiment\n---\n',
    });
    h.setActive(`${DIR}/${KEPT}`);
    await syncWorkflowChecklist(h.ctx);
    expect(h.vault.files()[README_PATH]).toBe(before);
    expect(h.vault.log.filter((c) => c.cmd === 'vault_modify')).toEqual([]);
    expect(h.notes).toEqual([{ kind: 'info', message: h.host.t('The workflow checklist already matches the folder.') }]);
  });

  it('without the section it warns and writes nothing', async () => {
    const before = readme('', false);
    h = createTestHost({ [README_PATH]: before, [`${DIR}/${MOVED}`]: workflowNote('WB010 Oligo Assembly') });
    h.setActive(README_PATH);
    await syncWorkflowChecklist(h.ctx);
    expect(h.vault.files()[README_PATH]).toBe(before);
    expect(h.notes).toEqual([{ kind: 'warn', message: h.host.t('README.labnote.md has no "Related Workflows" section.') }]);
  });

  it('without a README it says so', async () => {
    h = createTestHost({ [`${DIR}/${MOVED}`]: workflowNote('WB010 Oligo Assembly') });
    h.setActive(`${DIR}/${MOVED}`);
    await syncWorkflowChecklist(h.ctx);
    expect(h.notes).toEqual([{ kind: 'warn', message: h.host.t('This experiment has no README.labnote.md.') }]);
  });
});
