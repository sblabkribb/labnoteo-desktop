// @vitest-environment jsdom
/**
 * 샘플 설정 대화상자와 Global 폴더 옮기기(plan SP5 Task 28). 글자는 플러그인 settingsTab.ts 의 samplesSection·
 * renderCustomTypes 키(coreT)이고, 추적 스위치의 설명만 앱 키(바로 적용된다, D11)다. 저장하면 설정과 샘플 저장소가
 * 함께 바뀌고, Global 폴더가 바뀌면 옛 폴더의 샘플을 옮길지 묻고(#101), 지운 종류에 샘플이 있으면 되돌릴지 묻는다(#137).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { CompletionContext } from '@codemirror/autocomplete';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { DialogLayer } from '../../labnote/host/DialogLayer';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { appCommands, registerAllAppCommands } from '../../editor/commands/appCommands';
import { partitionCustomSampleTypes } from '../../labnote/port/customSampleTypes';
import { commitGlobalFolder } from '../../labnote/port/sampleSettings';
import { applySampleSettings, openSampleSettings, type SampleSettingsValue } from '../SampleSettingsDialog';
import { sampleCompletionSource } from '../complete';
import { sampleEditorConfig } from '../editorConfig';
import { createSampleEnv } from '../env';
import { clearSampleSourceCaches, registerSampleSources } from '../sources';
import { CONFLICTED, GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const BASE: SampleSettingsValue = { sampleTracking: true, customSampleTypes: [], globalSampleFolder: GLOBAL };
const SHARED = 'shared/labsamples';

let hosts: TestHost[] = [];
const host = (files: Record<string, string> = SAMPLE_VAULT, settings: Partial<SampleSettingsValue> = {}) => {
  const th = createTestHost(files, settings);
  hosts.push(th);
  return th;
};
const lang = getLang();
beforeEach(() => setLang('en'));
afterEach(() => {
  act(() => closeAllDialogs());
  for (const th of hosts) th.cleanup();
  hosts = [];
  clearSampleSourceCaches();
  setLang(lang);
  document.body.innerHTML = '';
});

const apply = (th: TestHost, before: SampleSettingsValue, after: SampleSettingsValue) =>
  act(() => applySampleSettings(createSampleEnv(th.ctx), th.ctx, before, after));

describe('SampleSettingsDialog', () => {
  it('custom types: rejected, italic and case-duplicate names are explained with the plugin sentences', async () => {
    render(<DialogLayer />);
    let result: Promise<SampleSettingsValue | undefined> | undefined;
    act(() => {
      result = openSampleSettings(BASE);
    });
    const input = screen.getByLabelText(coreT('Custom sample types')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Cell Line, Dna, 세포_용해물' } });
    fireEvent.blur(input);
    expect(
      screen.getByText(coreT('{0}: a space or - keeps a type from autocompleting, so it was not saved. Use {1} instead.', 'Cell Line', 'Cell_Line')),
    ).toBeTruthy();
    expect(
      screen.getByText(
        coreT(
          '{0}: differs from {1} only in letter case, so on Windows both would share one {Type}.json and their samples would mix. It was not saved.',
          'Dna',
          'DNA',
        ),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        coreT(
          '{0}: a _ next to a letter that is not A–Z or a digit shows the name in italics in the reading view, so it was not saved. Use {1} instead.',
          '세포_용해물',
          partitionCustomSampleTypes('세포_용해물', []).italic[0].suggestion,
        ),
      ),
    ).toBeTruthy();
    // 저장할 수 없는 이름은 칸에서 빠진다(플러그인의 t.setValue(s.customSampleTypes.join(', '))).
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'CellLine, Cell Line' } });
    // Save shows why a name is dropped and stays open; a second Save keeps the names that can be saved.
    fireEvent.click(screen.getByRole('button', { name: t('samples.settings.save') }));
    expect(document.querySelector('.sample-settings')).not.toBeNull();
    expect(input.value).toBe('CellLine');
    fireEvent.click(screen.getByRole('button', { name: t('samples.settings.save') }));
    await expect(result).resolves.toEqual({ ...BASE, customSampleTypes: ['CellLine'] });
  });

  const settled = (p: Promise<unknown>) => {
    const s = { done: false };
    void p.then(() => {
      s.done = true;
    });
    return s;
  };

  it('a refused Global folder: change, blur, Save keeps the dialog open with the reason (browser order)', async () => {
    render(<DialogLayer />);
    let result: Promise<SampleSettingsValue | undefined> | undefined;
    act(() => {
      result = openSampleSettings(BASE);
    });
    const done = settled(result!);
    const folder = screen.getByLabelText(coreT('Global sample folder')) as HTMLInputElement;
    const notice = commitGlobalFolder(coreT, 'a/con', GLOBAL).notice!;
    fireEvent.change(folder, { target: { value: 'a/con' } });
    fireEvent.blur(folder);
    fireEvent.click(screen.getByRole('button', { name: t('samples.settings.save') }));
    await act(async () => {});
    expect(done.done).toBe(false);
    expect(document.querySelector('.sample-settings')).not.toBeNull();
    expect(screen.getByText(notice)).toBeTruthy();
    expect(folder.value).toBe(GLOBAL);
    // Seen: Save again keeps the folder it was set back to.
    fireEvent.click(screen.getByRole('button', { name: t('samples.settings.save') }));
    await expect(result).resolves.toEqual(BASE);
  });

  it('a refused custom type: change, blur, Save keeps the dialog open with the reason (browser order)', async () => {
    render(<DialogLayer />);
    let result: Promise<SampleSettingsValue | undefined> | undefined;
    act(() => {
      result = openSampleSettings(BASE);
    });
    const done = settled(result!);
    const input = screen.getByLabelText(coreT('Custom sample types')) as HTMLInputElement;
    const notice = coreT('{0}: a space or - keeps a type from autocompleting, so it was not saved. Use {1} instead.', 'Cell Line', 'Cell_Line');
    fireEvent.change(input, { target: { value: 'Cell Line' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: t('samples.settings.save') }));
    await act(async () => {});
    expect(done.done).toBe(false);
    expect(document.querySelector('.sample-settings')).not.toBeNull();
    expect(screen.getByText(notice)).toBeTruthy();
    // Editing the field again clears the stop; a valid name then saves at once.
    fireEvent.change(input, { target: { value: 'CellLine' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: t('samples.settings.save') }));
    await expect(result).resolves.toEqual({ ...BASE, customSampleTypes: ['CellLine'] });
  });

  // #560 (0.140.2): CON.json cannot exist on Windows. A new device name is refused; a stored one stays with a warning.
  it('custom types: a Windows device name is refused, and one stored before is kept with a warning', () => {
    render(<DialogLayer />);
    act(() => void openSampleSettings({ ...BASE, customSampleTypes: ['AUX'] }));
    expect(
      screen.getByText(
        coreT(
          '{0} is a name Windows keeps for devices: its {Type}.json cannot be made or checked out on Windows, and git stops there. Move its samples to another type with Change type, then remove the name.',
          'AUX',
        ),
      ),
    ).toBeTruthy();
    const input = screen.getByLabelText(coreT('Custom sample types')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'AUX, CON, Strain' } });
    fireEvent.blur(input);
    expect(
      screen.getByText(
        coreT(
          '{0}: Windows keeps this name for a device, so its {Type}.json cannot be made there. It was not saved. Use another name, such as {1}.',
          'CON',
          'CONSample',
        ),
      ),
    ).toBeTruthy();
    expect(input.value).toBe('AUX, Strain');
  });

  it('labels and descriptions are the plugin keys', () => {
    render(<DialogLayer />);
    act(() => void openSampleSettings({ ...BASE, customSampleTypes: ['Cell Line'] }));
    expect(screen.getByText(coreT('Sample tracking'))).toBeTruthy();
    expect(screen.getByText(coreT('Custom sample types'))).toBeTruthy();
    expect(screen.getByText(coreT('Global sample folder'))).toBeTruthy();
    expect(screen.getByText(t('samples.settings.trackingLive'))).toBeTruthy();
    expect(screen.getByText(coreT('Vault-relative folder for vault-global samples.'))).toBeTruthy();
    // A name stored before validation existed is kept and explained, as renderCustomTypes does under the description.
    expect(
      screen.getByText(
        coreT(
          '{0} cannot be autocompleted in notes (a space or -). Rename it, e.g. {1}, if you have no samples of it yet.',
          'Cell Line',
          'Cell_Line',
        ),
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText(coreT('Sample tracking')) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('.dialog [style]')).toBeNull();
  });

  it('a refused Global folder shows the plugin sentence and goes back; Cancel resolves undefined', async () => {
    render(<DialogLayer />);
    let result: Promise<SampleSettingsValue | undefined> | undefined;
    act(() => {
      result = openSampleSettings(BASE);
    });
    const folder = screen.getByLabelText(coreT('Global sample folder')) as HTMLInputElement;
    fireEvent.change(folder, { target: { value: 'a/con' } });
    fireEvent.blur(folder);
    expect(screen.getByText(commitGlobalFolder(coreT, 'a/con', GLOBAL).notice!)).toBeTruthy();
    expect(folder.value).toBe(GLOBAL);
    fireEvent.click(screen.getByRole('button', { name: coreT('Cancel') }));
    await expect(result).resolves.toBeUndefined();
  });
});

describe('commitGlobalFolder (settingsTab.ts port)', () => {
  it('an empty Global folder saves the default', () => {
    expect(commitGlobalFolder(coreT, '  ', 'shared/labsamples')).toEqual({ value: 'resources/labsamples' });
  });

  it('a reserved name is refused with the invalidFolderText reason', () => {
    const r = commitGlobalFolder(coreT, 'a/con', GLOBAL);
    expect(r.value).toBe(GLOBAL);
    expect(r.notice).toBe(
      coreT('"{0}" cannot be the Global sample folder: {1} It is back to {2}.', 'a/con', coreT('"{0}" is a name Windows keeps for devices.', 'con'), GLOBAL),
    );
  });

  it('a Global folder inside an experiment is refused with the plugin sentence', () => {
    const r = commitGlobalFolder(coreT, LOCAL, GLOBAL);
    expect(r).toEqual({
      value: GLOBAL,
      notice: coreT(
        '"{0}" cannot be the Global sample folder: {1} It is back to {2}.',
        LOCAL,
        coreT('It is inside the experiment {0}, whose own samples it holds.', 'labnote/061_PCR'),
        GLOBAL,
      ),
    });
  });

  it('a valid folder is kept, trimmed', () => {
    expect(commitGlobalFolder(coreT, ` ${SHARED} `, GLOBAL)).toEqual({ value: SHARED });
  });
});

describe('applySampleSettings', () => {
  it('removing a type that has samples offers to put it back (#137)', async () => {
    const two = JSON.stringify({ '배지-1': { type: '배지', alias: 'LB', descriptions: [], sources: [] }, '배지-2': { type: '배지', alias: 'SOC', descriptions: [], sources: [] } });
    const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/배지.json`]: two }, { customSampleTypes: ['배지'] });
    th.answer.confirm(true);
    const before = { ...BASE, customSampleTypes: ['배지'] };
    await apply(th, before, { ...before, customSampleTypes: [] });
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain('배지');
    expect(th.asked.confirm[0].message).toContain(coreT('{0}: {1} sample(s)', '배지', '2'));
    // The plugin key, joined from its lines (escapes.test.ts): it has a Korean text, so it is a real l10n key.
    const question = ['Samples of the removed sample type(s) will no longer show:', '', '{0}', '', 'Put the type(s) back in the list?'].join('\n');
    expect(th.asked.confirm[0].message).toBe(coreT(question, `- ${coreT('{0}: {1} sample(s)', '배지', '2')}`));
    setLang('ko');
    expect(coreT(question)).not.toBe(question);
    setLang('en');
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe(coreT('Put back'));
    expect(th.ctx.settings.customSampleTypes).toEqual(['배지']);
    expect(th.notes.at(-1)?.message).toBe(coreT('Put back: {0}', '배지'));
  });

  it('removing a type with no samples asks nothing', async () => {
    const th = host(SAMPLE_VAULT, { customSampleTypes: ['배지'] });
    const before = { ...BASE, customSampleTypes: ['배지'] };
    await apply(th, before, { ...before, customSampleTypes: [] });
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.ctx.settings.customSampleTypes).toEqual([]);
  });

  it('changing the Global folder offers to move samples; files move, sources trashed, never vault_remove', async () => {
    const th = host();
    th.answer.confirm(true);
    await apply(th, BASE, { ...BASE, globalSampleFolder: SHARED });
    expect(th.ctx.settings.globalSampleFolder).toBe(SHARED);
    expect(th.asked.confirm[0].message).toContain(
      coreT('The old Global sample folder {0} still has {1} sample(s). Move them to the new folder {2}?', GLOBAL, '1', SHARED),
    );
    expect(th.asked.confirm[0].message).toContain(coreT('Product catalog files move too: {0}', 'Reagent_vendor.json'));
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe(coreT('Move samples'));
    const files = th.vault.files();
    expect(files[`${SHARED}/Reagent.json`]).toBeDefined();
    expect(JSON.parse(files[`${SHARED}/Reagent.json`])['Reagent-7'].alias).toBe('Taq');
    expect(files[`${SHARED}/Reagent_vendor.json`]).toBeDefined();
    expect(files[`${GLOBAL}/Reagent.json`]).toBeUndefined();
    expect(th.vault.recycleBin.map((e) => e.path)).toContain(`${GLOBAL}/Reagent.json`);
    expect(th.vault.log.some((l) => l.cmd === 'vault_remove')).toBe(false);
  });

  it('declining the move leaves the old folder and says so', async () => {
    const th = host();
    th.answer.confirm(false);
    await apply(th, BASE, { ...BASE, globalSampleFolder: SHARED });
    expect(th.vault.files()[`${GLOBAL}/Reagent.json`]).toBe(SAMPLE_VAULT[`${GLOBAL}/Reagent.json`]);
    expect(th.vault.files()[`${SHARED}/Reagent.json`]).toBeUndefined();
    expect(th.notes.at(-1)?.message).toBe(coreT('Samples in the old folder are not shown. Set the folder back to see them again.'));
  });

  it('a conflicted registry in either folder stops the move before anything is written', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${SHARED}/Reagent.json`]: CONFLICTED });
    th.answer.confirm(true);
    await apply(th, BASE, { ...BASE, globalSampleFolder: SHARED });
    expect(th.vault.files()[`${SHARED}/Reagent.json`]).toBe(CONFLICTED);
    expect(th.vault.files()[`${GLOBAL}/Reagent.json`]).toBe(SAMPLE_VAULT[`${GLOBAL}/Reagent.json`]);
    expect(th.vault.recycleBin).toHaveLength(0);
    expect(th.notes.at(-1)).toEqual({ kind: 'warn', message: t('samples.registryUnreadable', `${SHARED}/Reagent.json`) });
  });

  it('a conflicted registry in the OLD folder stops the move before anything is written (D13)', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/Reagent.json`]: CONFLICTED });
    th.answer.confirm(true);
    await apply(th, BASE, { ...BASE, globalSampleFolder: SHARED });
    expect(th.vault.files()[`${GLOBAL}/Reagent.json`]).toBe(CONFLICTED);
    expect(th.vault.recycleBin).toHaveLength(0);
    expect(Object.keys(th.vault.files()).some((f) => f.startsWith(`${SHARED}/`))).toBe(false);
    expect(th.notes.at(-1)).toEqual({ kind: 'warn', message: t('samples.registryUnreadable', `${GLOBAL}/Reagent.json`) });
  });

  it('a Global folder change together with a type removal still moves the removed type, then offers it back', async () => {
    const two = JSON.stringify({ '배지-1': { type: '배지', alias: 'LB', descriptions: [], sources: [] } });
    const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/배지.json`]: two }, { customSampleTypes: ['배지'] });
    th.answer.confirm(true, true);
    const before = { ...BASE, customSampleTypes: ['배지'] };
    await apply(th, before, { ...before, customSampleTypes: [], globalSampleFolder: SHARED });
    expect(th.vault.files()[`${SHARED}/배지.json`]).toBeDefined();
    expect(th.vault.files()[`${GLOBAL}/배지.json`]).toBeUndefined();
    expect(th.asked.confirm).toHaveLength(2);
    expect(th.asked.confirm[1].message).toContain(coreT('{0}: {1} sample(s)', '배지', '1'));
    expect(th.ctx.settings.customSampleTypes).toEqual(['배지']);
  });

  it('an experiment registry set as Global by mistake is not moved (#408)', async () => {
    const th = host();
    await apply(th, { ...BASE, globalSampleFolder: LOCAL }, BASE);
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(SAMPLE_VAULT[`${LOCAL}/DNA.json`]);
    expect(th.notes.at(-1)?.message).toContain(LOCAL);
  });

  it('turning tracking off applies at once: highlights and completion disappear without reload', async () => {
    registerSampleSources();
    const th = host();
    const m = await th.mount(NOTE);
    const view: EditorView = m.view();
    await waitFor(() => expect(view.contentDOM.querySelectorAll('.lno-sample-id').length).toBeGreaterThan(0));
    const complete = () => {
      const state = view.state.update({ changes: { from: view.state.doc.length, insert: '\n@DNA;' } }).state;
      const source = sampleCompletionSource({ notePath: () => NOTE, config: (s) => s.facet(sampleEditorConfig), env: () => createSampleEnv(th.ctx) });
      return source(new CompletionContext(state, state.doc.length, false));
    };
    expect(await complete()).not.toBeNull();
    await apply(th, BASE, { ...BASE, sampleTracking: false });
    expect(th.ctx.settings.sampleTracking).toBe(false);
    await waitFor(() => expect(view.contentDOM.querySelectorAll('.lno-sample-id')).toHaveLength(0));
    expect(await complete()).toBeNull();
  });
});

describe('app.sample-settings', () => {
  it('the app command is in the palette with ko and en names', () => {
    setLang('ko');
    expect(t('cmd.sampleSettings')).toBe('샘플 설정');
    setLang('en');
    expect(t('cmd.sampleSettings')).toBe('Sample settings');
    registerAllAppCommands();
    expect(appCommands().some((c) => c.id === 'app.sample-settings' && c.nameKey === 'cmd.sampleSettings')).toBe(true);
  });
});
