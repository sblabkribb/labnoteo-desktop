// @vitest-environment jsdom
/**
 * 예전(VS Code 시절) 보관함: 실험 폴더의 README 가 `README.md` 이고, Workflow 노트는 `NNN_Wxxx_*.md`, 체크리스트 줄은 앞의 "- " 없이,
 * 줄 끝은 CRLF 다. Workflow 완료(실험 탭의 체크박스, 보기 머리의 칩, 팔레트 명령, 권유)와 README 체크리스트를 읽고 쓰는 다른 명령이
 * 실험마다 README 를 고른다: README.labnote.md, 없으면 README.md.
 */
import { setLang } from '../../../i18n/lang';
import { appCommandById, clearAppCommandsForTest, registerAllAppCommands } from '../../../editor/commands/appCommands';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { notePosition } from '../../notePosition';
import { isWorkflowNote, readmeNameIn, resolveReadmePath } from '../../paths';
import { readChecklistLabels } from '../../port/aliasHints';
import { syncWorkflowChecklist } from '../syncChecklist';
import { isExperimentReadme, offerWorkflowDoneNudge, readWorkflowTick, registerWorkflowInReadme, toggleWorkflowDone, toggleWorkflowTick } from '../workflow';

const DIR = 'labnote/001_new';
const README_MD = `${DIR}/README.md`;
const NEW_README = `${DIR}/README.labnote.md`;
const LEGACY_WF = '001_WD090_Genome_Editing_Design_test.md';
const LEGACY_WF2 = '002_WB010_DNA_Oligomer_Assembly.md';
const NEW_WF = '003_WD010_General_Design_of_Experiment.labnote.md';

const LINES = [
  `[ ] [WD090 Genome Editing Design test](./${LEGACY_WF})`,
  `[x] [WB010 DNA Oligomer Assembly](./${LEGACY_WF2})`,
  `[ ] [WD010 General Design of Experiment](./${NEW_WF})`,
];

function legacyReadme(lines = LINES): string {
  return ['---', 'title: new', 'status: in-progress', 'last_updated_date: 2026-01-01', '---', '', '## 🗂️ Related Workflows', '', ...lines, '', '## Summary and Discussion', ''].join('\r\n');
}

const wfNote = (id: string, name: string, end = '') =>
  ['---', `title: ${id} ${name}`, '---', `## [${id} ${name}]`, '', '### [UHW250 DNA Assembly] a', '#### Meta', `- End_date: ${end}`, ''].join('\r\n');

function legacyVault(): Record<string, string> {
  return {
    [README_MD]: legacyReadme(),
    [`${DIR}/${LEGACY_WF}`]: wfNote('WD090', 'Genome Editing Design'),
    [`${DIR}/${LEGACY_WF2}`]: wfNote('WB010', 'DNA Oligomer Assembly', '2026-01-02'),
    [`${DIR}/${NEW_WF}`]: wfNote('WD010', 'General Design of Experiment', '2026-01-02'),
  };
}

let h: TestHost;
beforeEach(() => setLang('ko'));
afterEach(() => h?.cleanup());

const readmeText = () => h.vault.files()[README_MD];
/** CRLF 만 남았다(LF 하나도 홀로 있지 않다). */
const allCrlf = (text: string) => text.replace(/\r\n/g, '').includes('\n') === false;

describe('README per experiment', () => {
  it('readmeNameIn prefers README.labnote.md, then README.md, any case', () => {
    expect(readmeNameIn(['a.md', 'README.md'])).toBe('README.md');
    expect(readmeNameIn(['readme.md', 'README.labnote.md'])).toBe('README.labnote.md');
    expect(readmeNameIn(['Readme.MD'])).toBe('Readme.MD');
    expect(readmeNameIn(['001_x.md'])).toBeUndefined();
  });

  it('resolveReadmePath finds README.md in a legacy folder and README.labnote.md when both exist', async () => {
    h = createTestHost(legacyVault());
    expect(await resolveReadmePath(h.host.fs, DIR)).toBe(README_MD);
    h.cleanup();
    h = createTestHost({ ...legacyVault(), [NEW_README]: '---\ntitle: n\n---\n' });
    expect(await resolveReadmePath(h.host.fs, DIR)).toBe(NEW_README);
    h.cleanup();
    // 어느 것도 없으면 새 이름
    h = createTestHost({});
    expect(await resolveReadmePath(h.host.fs, DIR)).toBe(NEW_README);
  });

  it('a legacy README.md and NNN_Wxxx_*.md are an experiment README and a Workflow note', () => {
    expect(isExperimentReadme(README_MD)).toBe(true);
    expect(isExperimentReadme('labnote/README.md')).toBe(false);
    expect(isExperimentReadme(`${DIR}/resources/README.md`)).toBe(false);
    expect(isWorkflowNote(`${DIR}/${LEGACY_WF}`)).toBe(true);
    expect(isWorkflowNote(`${DIR}/${NEW_WF}`)).toBe(true);
    expect(isWorkflowNote(README_MD)).toBe(false);
    expect(isWorkflowNote(`${DIR}/001_new.md`)).toBe(false);
    expect(isWorkflowNote(`${DIR}/resources/001_WD090_x.md`)).toBe(false);
    expect(notePosition(`${DIR}/${LEGACY_WF}`, wfNote('WD090', 'Genome Editing Design')).kind).toBe('workflow');
    const readmePos = notePosition(README_MD, legacyReadme());
    expect(readmePos.kind).toBe('readme');
    expect(readmePos.kind === 'readme' && [readmePos.wfDone, readmePos.wfTotal]).toEqual([1, 3]);
  });
});

describe('Workflow completion in a legacy vault', () => {
  it('toggleWorkflowTick writes README.md in place (bare lines, CRLF) and never creates README.labnote.md', async () => {
    h = createTestHost(legacyVault());
    expect(await toggleWorkflowTick(h.ctx, DIR, LEGACY_WF)).toBe(true);
    expect(readmeText()).toContain(`\r\n[x] [WD090 Genome Editing Design test](./${LEGACY_WF})\r\n`);
    expect(await toggleWorkflowTick(h.ctx, DIR, NEW_WF)).toBe(true);
    expect(readmeText()).toContain(`\r\n[x] [WD010 General Design of Experiment](./${NEW_WF})\r\n`);
    expect(await toggleWorkflowTick(h.ctx, DIR, LEGACY_WF2)).toBe(false);
    expect(readmeText()).toContain(`\r\n[ ] [WB010 DNA Oligomer Assembly](./${LEGACY_WF2})\r\n`);
    expect(allCrlf(readmeText())).toBe(true);
    expect(h.vault.files()[NEW_README]).toBeUndefined();
    expect(h.notes.filter((n) => n.kind === 'warn')).toEqual([]);
  });

  it('a legacy note whose line still links the .labnote.md name (or the reverse) is found by its name without extension', async () => {
    const legacyAsNew = '001_WD090_Genome_Editing_Design_test.labnote.md';
    const newAsLegacy = '003_WD010_General_Design_of_Experiment.md';
    const lines = [`[ ] [WD090 Genome Editing Design test](./${legacyAsNew})`, `- [x] [WD010 General](./${newAsLegacy})`];
    h = createTestHost({ ...legacyVault(), [README_MD]: legacyReadme(lines) });
    expect(await readWorkflowTick(h.ctx, `${DIR}/${LEGACY_WF}`)).toBe(false);
    expect(await readWorkflowTick(h.ctx, `${DIR}/${NEW_WF}`)).toBe(true);
    expect(await toggleWorkflowTick(h.ctx, DIR, LEGACY_WF)).toBe(true);
    expect(readmeText()).toContain(`
[x] [WD090 Genome Editing Design test]`);
    // 체크리스트에 없는 노트는 알리고 아무것도 쓰지 않는다
    const before = readmeText();
    expect(await toggleWorkflowTick(h.ctx, DIR, LEGACY_WF2)).toBeUndefined();
    expect(readmeText()).toBe(before);
    expect(h.notes.filter((n) => n.kind === 'warn')).toHaveLength(1);
  });

  it('readWorkflowTick (the header chip) reads README.md for legacy and new Workflow notes', async () => {
    h = createTestHost(legacyVault());
    expect(await readWorkflowTick(h.ctx, `${DIR}/${LEGACY_WF}`)).toBe(false);
    expect(await readWorkflowTick(h.ctx, `${DIR}/${LEGACY_WF2}`)).toBe(true);
    expect(await readWorkflowTick(h.ctx, `${DIR}/${NEW_WF}`)).toBe(false);
    expect(await toggleWorkflowDone(h.ctx, `${DIR}/${NEW_WF}`)).toBe(true);
    expect(await readWorkflowTick(h.ctx, `${DIR}/${NEW_WF}`)).toBe(true);
  });

  it('the nudge asks and its button ticks the README.md line', async () => {
    h = createTestHost(legacyVault());
    expect(await offerWorkflowDoneNudge(h.ctx, `${DIR}/${LEGACY_WF}`)).toBe(true);
    const i = h.noteOpts.findIndex((o) => o.action);
    h.noteOpts[i].action!.run();
    await vi.waitFor(() => expect(readmeText()).toContain(`\r\n[x] [WD090 Genome Editing Design test]`));
    expect(h.vault.files()[NEW_README]).toBeUndefined();
  });

  describe('palette command', () => {
    afterEach(() => clearAppCommandsForTest());
    it('shows on a legacy Workflow note and toggles its README.md line', async () => {
      registerAllAppCommands();
      const cmd = appCommandById('app.toggleWorkflowDone')!;
      h = createTestHost(legacyVault());
      h.setActive(README_MD);
      expect(cmd.available!(h.ctx)).toBe(false);
      h.setActive(`${DIR}/${LEGACY_WF}`);
      expect(cmd.available!(h.ctx)).toBe(true);
      await cmd.run(h.ctx);
      expect(readmeText()).toContain(`\r\n[x] [WD090 Genome Editing Design test]`);
    });
  });
});

describe('other README checklist readers and writers in a legacy vault', () => {
  it('registerWorkflowInReadme adds the new Workflow to README.md', async () => {
    h = createTestHost(legacyVault());
    const fileName = '004_WB030_DNA_Assembly.labnote.md';
    await h.host.fs.write(`${DIR}/${fileName}`, wfNote('WB030', 'DNA Assembly'));
    expect(await registerWorkflowInReadme(h.ctx, await resolveReadmePath(h.host.fs, DIR), { title: 'WB030 DNA Assembly', fileName })).toBe('registered');
    expect(readmeText()).toContain(fileName);
    expect(allCrlf(readmeText())).toBe(true);
  });

  it('sync-workflow-checklist reads and writes README.md', async () => {
    h = createTestHost(legacyVault());
    const fileName = '004_WB030_DNA_Assembly.labnote.md';
    await h.host.fs.write(`${DIR}/${fileName}`, wfNote('WB030', 'DNA Assembly'));
    h.setActive(`${DIR}/${NEW_WF}`);
    await syncWorkflowChecklist(h.ctx);
    expect(readmeText()).toContain(fileName);
    expect(h.vault.files()[NEW_README]).toBeUndefined();
    expect(h.notes.map((n) => n.message).join('\n')).not.toMatch(/README\.labnote\.md/);
  });

  it('readChecklistLabels (same-alias hints) reads README.md', async () => {
    h = createTestHost(legacyVault());
    const labels = await readChecklistLabels(h.host.fs, DIR);
    expect(labels.size).toBeGreaterThan(0);
  });
});
