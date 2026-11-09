// @vitest-environment jsdom
/**
 * 샘플 정의 대화상자(plan SP5 Task 23). 모델(port/sampleDefinitionModel.ts)은 vendor sampleDefinitionModal.ts 의 onOpen 이
 * 만드는 줄과 단추 순서를 그대로 내고, 대화상자는 고른 동작(또는 열 사용처)만 돌려준다. 흐름은 Task 24 의 명령이 돌린다.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getLang, setLang } from '../../i18n/lang';
import { coreT } from '../../labnote/i18n';
import { DialogLayer } from '../../labnote/host/DialogLayer';
import { closeAllDialogs, openSampleDefinitionDialog } from '../../labnote/host/dialogStore';
import {
  definitionModel,
  groupUsages,
  moveTarget,
  OPEN_USAGE_GROUPS,
  SAMPLE_ACTION_LABEL,
  type UsageGroup,
} from '../../labnote/port/sampleDefinitionModel';
import { GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const env = { t: coreT, globalFolder: () => GLOBAL };
/** The button row (the frame's x button shares the name 'Close'). */
const actionRow = () => within(document.querySelector('.sample-def-actions') as HTMLElement);
const LOCAL_DEF = { scope: 'local' as const, folder: LOCAL, type: 'DNA', id: 'DNA-1', record: JSON.parse(SAMPLE_VAULT[`${LOCAL}/DNA.json`])['DNA-1'] };
const GLOBAL_DEF = { scope: 'global' as const, folder: GLOBAL, type: 'Reagent', id: 'Reagent-7', record: JSON.parse(SAMPLE_VAULT[`${GLOBAL}/Reagent.json`])['Reagent-7'] };
const CATALOG_DEF = { scope: 'catalog' as const, folder: GLOBAL, file: `${GLOBAL}/Reagent_vendor.json`, type: 'Reagent', id: 'Reagent-900', record: { type: 'Reagent', alias: 'dNTP', descriptions: ['mix'], sources: [] } };

const lang = getLang();
beforeEach(() => setLang('en'));
afterEach(() => {
  act(() => closeAllDialogs());
  setLang(lang);
  document.body.innerHTML = '';
});

describe('definitionModel', () => {
  it('vendor action order and labels; catalog is read-only', () => {
    const m = definitionModel(env, LOCAL_DEF, { docPath: NOTE });
    expect(m.rows.find((r) => r.label === coreT('Scope'))?.value).toBe(coreT('Local'));
    expect(m.actions).toEqual(['edit', 'delete', 'discard', 'moveGlobal', 'changeType', 'openJson']);
    expect(m.actions.map((a) => SAMPLE_ACTION_LABEL[a])).toEqual(['Edit sample', 'Delete sample', 'Mark as discarded', 'Move to Global', 'Change type', 'Open JSON file']);
    expect(definitionModel(env, GLOBAL_DEF, { docPath: NOTE }).actions).toEqual(['edit', 'delete', 'undiscard', 'moveLocal', 'changeType', 'openJson']);
    expect(definitionModel(env, CATALOG_DEF, { docPath: NOTE }).actions).toEqual(['openJson']);
    expect(definitionModel(env, CATALOG_DEF, { docPath: NOTE }).readOnly).toBe(true);
    expect(m.readOnly).toBe(false);
  });

  it('rows as onOpen builds them: type, ID, alias, location, scope and file; descriptions with their notes; defined in', () => {
    const m = definitionModel(env, { ...LOCAL_DEF, record: { ...LOCAL_DEF.record, descriptionSources: { '001_clone': 'miniprep' } } }, { docPath: NOTE });
    expect(m.title).toContain('DNA-1');
    expect(m.rows.map((r) => [r.label, r.value])).toEqual([
      ['Type', 'DNA'],
      ['ID', 'DNA-1'],
      ['Alias', 'pUC'],
      ['Location', 'Freezer A / B3'],
      ['Scope', 'Local'],
      ['File', `${LOCAL}/DNA.json`],
      ['Description', 'miniprep'],
      ['Defined in', '001_clone'],
    ]);
    expect(m.rows.find((r) => r.label === 'Description')?.sources).toEqual(['001_clone']);
    const g = definitionModel(env, GLOBAL_DEF, { docPath: NOTE });
    expect(g.rows.find((r) => r.label === 'Discarded')?.value).toBe('2026-10-01');
    const c = definitionModel(env, CATALOG_DEF, { docPath: NOTE });
    expect(c.rows.find((r) => r.label === 'File')?.value).toBe(`${GLOBAL}/Reagent_vendor.json`);
    expect(c.rows.find((r) => r.label === 'Scope')?.value).toBe(coreT('Product catalog (read-only)'));
    expect(c.notice).toContain('Reagent.json');
  });

  it('a Global sample from a vault-root note offers no Move', () => {
    expect(definitionModel(env, GLOBAL_DEF, { docPath: 'Home.md' }).actions).not.toContain('moveLocal');
    expect(moveTarget(env, GLOBAL_DEF, { docPath: 'Home.md' })).toBeUndefined();
    expect(moveTarget(env, GLOBAL_DEF, { localFolder: LOCAL })).toEqual({ toFolder: LOCAL, label: coreT('Move to Local') });
    expect(moveTarget({ ...env, globalFolder: () => LOCAL }, LOCAL_DEF, { docPath: NOTE })).toBeUndefined();
  });
});

describe('groupUsages', () => {
  it('groups by experiment in folder order, notes outside experiments last, labelled as the vendor list', () => {
    const groups = groupUsages([
      { path: 'Home.md', line: 0, ch: 0, heading: '' },
      { path: 'labnote/062_Gel/001_run.labnote.md', line: 2, ch: 0, heading: 'Run' },
      { path: 'labnote/061_PCR/001_clone.labnote.md', line: 4, ch: 4, heading: '' },
      { path: 'labnote/061_PCR/001_clone.labnote.md', line: 6, ch: 1, heading: '' },
    ]);
    expect(groups.map((g) => [g.experiment, g.spots.length])).toEqual([
      ['061_PCR', 2],
      ['062_Gel', 1],
      ['', 1],
    ]);
    expect(groups[0].spots[0]).toEqual({ path: 'labnote/061_PCR/001_clone.labnote.md', line: 4, ch: 4, label: '001_clone.labnote · Line 5' });
    expect(groups[1].spots[0].label).toBe('001_run.labnote · Run · line 3');
    expect(OPEN_USAGE_GROUPS).toBe(5);
  });
});

describe('SampleDefinitionDialog', () => {
  it('usages load after the dialog opens; first 5 groups open; clicking a spot returns open', async () => {
    let resolve!: (g: UsageGroup[]) => void;
    const p = openSampleDefinitionDialog(definitionModel(env, LOCAL_DEF, { docPath: NOTE }), new Promise((r) => (resolve = r)));
    render(<DialogLayer />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(coreT('Loading…'))).toBeTruthy();
    resolve(Array.from({ length: 6 }, (_, i) => ({ experiment: `06${i}`, spots: [{ path: `labnote/06${i}/a.labnote.md`, line: 3, label: 'L4' }] })));
    await waitFor(() => expect(document.querySelectorAll('details').length).toBe(6));
    expect(document.querySelectorAll('details[open]').length).toBe(5);
    fireEvent.click(screen.getAllByText('L4')[0]);
    expect(await p).toEqual({ open: { path: 'labnote/060/a.labnote.md', line: 3 } });
  });

  it('an action button returns the action; the move button carries the move label; no style attributes', async () => {
    const p = openSampleDefinitionDialog(definitionModel(env, LOCAL_DEF, { docPath: NOTE }), Promise.resolve([]));
    render(<DialogLayer />);
    const labels = actionRow().getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Edit sample', 'Delete sample', 'Mark as discarded', 'Move to Global', 'Change type', 'Open JSON file', 'Close']);
    await waitFor(() => expect(screen.getByText(coreT('{0} is not used in any note.', 'DNA-1'))).toBeTruthy());
    expect(document.querySelectorAll('[style]').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Change type' }));
    expect(await p).toEqual({ action: 'changeType' });
  });

  it('a failed usage load says so; Close returns undefined', async () => {
    const p = openSampleDefinitionDialog(definitionModel(env, CATALOG_DEF, { docPath: NOTE }), Promise.reject(new Error('x')));
    render(<DialogLayer />);
    expect(screen.getByText(/are read-only here/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(coreT('Could not list the usages.'))).toBeTruthy());
    fireEvent.click(actionRow().getByRole('button', { name: coreT('Close') }));
    expect(await p).toBeUndefined();
  });

  it('Escape returns undefined and focus returns to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const p = openSampleDefinitionDialog(definitionModel(env, LOCAL_DEF, { docPath: NOTE }), Promise.resolve([]));
    render(<DialogLayer />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(await p).toBeUndefined();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('renders in Korean with the plugin text', async () => {
    setLang('ko');
    void openSampleDefinitionDialog(definitionModel(env, LOCAL_DEF, { docPath: NOTE }), Promise.resolve([]));
    render(<DialogLayer />);
    expect(actionRow().getByRole('button', { name: '닫기' })).toBeTruthy();
    expect(screen.getByText('보관 위치')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(coreT('{0} is not used in any note.', 'DNA-1'))).toBeTruthy());
  });
});
