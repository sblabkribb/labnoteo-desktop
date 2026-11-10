// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { readFileSync } from 'node:fs';
import type { InvokeFn } from '../../../integrations/netIpc';
import { setLang } from '../../../i18n/lang';
import { catalogs } from '../../../i18n/t';
import { DialogLayer } from '../../../labnote/host/DialogLayer';
import { closeAllDialogs } from '../../../labnote/host/dialogStore';
import type { CommandContext } from '../../../labnote/commands/context';
import { appCommandById, clearAppCommandsForTest, registerAllAppCommands } from '../../../editor/commands/appCommands';
import { layoutStore } from '../../../ui/layoutStore';
import { BUILTIN_SKIN } from '../builtin';
import { SkinImportDialog } from '../ImportDialog';
import { exportSkinFile, importSkinFile } from '../transfer';
import { SKIN_ERROR_KINDS, discardStagedSkin, exportSkin, pickSkinFile, skinErrorText, type StagedSkin } from '../store';
import type { SkinUrls } from '../useSkin';
import type { SkinManifest } from '../types';

vi.mock('../../../ui/SettingsModal', () => ({ openSettings: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === 'skin_list' ? [] : cmd === 'skin_export' ? true : null)),
}));

const PNG = [0x89, 0x50, 0x4e, 0x47];
const manifest: SkinManifest = {
  ...BUILTIN_SKIN,
  id: 'pipette-pal',
  name: 'Pipette <b>Pal</b>',
  author: 'Kim',
  licence: 'CC-BY-4.0',
  version: '1.2.0',
  description: 'A tiny pipette.',
};
const staged: StagedSkin = {
  stagingId: 'ab'.repeat(16),
  manifest,
  sheets: { idle: PNG, talk: PNG, think: PNG, done: PNG },
};

function fakeInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    return handler(cmd, args);
  }) as InvokeFn;
  return { invoke, calls };
}

function fakeUrls() {
  let n = 0;
  const live = new Set<string>();
  const urls: SkinUrls = {
    create: () => {
      const u = `blob:test/${++n}`;
      live.add(u);
      return u;
    },
    revoke: (u) => void live.delete(u),
  };
  return { urls, live };
}

beforeEach(() => setLang('ko'));
afterEach(() => {
  act(() => closeAllDialogs());
  cleanup();
  setLang('ko');
});

describe('skin pack IPC (Task 17)', () => {
  it('pick, discard and export send only ids, never a path or bytes', async () => {
    const { invoke, calls } = fakeInvoke((cmd) => (cmd === 'skin_import_pick' ? staged : cmd === 'skin_export' ? true : true));
    expect(await pickSkinFile(invoke)).toEqual(staged);
    await discardStagedSkin(staged.stagingId, invoke);
    expect(await exportSkin('pipette-pal', invoke)).toBe(true);
    expect(calls).toEqual([
      ['skin_import_pick', {}],
      ['skin_staging_discard', { stagingId: staged.stagingId }],
      ['skin_export', { id: 'pipette-pal' }],
    ]);
  });

  it('every error kind has a short ko and en message; file names show as given', () => {
    for (const lang of ['ko', 'en'] as const) {
      setLang(lang);
      for (const kind of SKIN_ERROR_KINDS) {
        const text = skinErrorText({ kind, detail: 'x.svg' });
        expect(text, kind).not.toMatch(/^skin\./);
        expect(text.length, kind).toBeLessThan(80);
      }
    }
    setLang('ko');
    expect(skinErrorText({ kind: 'fileNotAllowed', detail: 'x.svg' })).toBe('허용되지 않는 파일이 들어 있어요: x.svg');
    expect(skinErrorText({ kind: 'tooLarge' })).toBe('파일이 너무 커요.');
    expect(skinErrorText({ kind: 'licenceMissing' })).toBe('라이선스가 필요해요.');
    expect(skinErrorText('boom')).toBe(catalogs.ko['skin.error.io']);
  });
});

describe('SkinImportDialog', () => {
  it('is named, shows the untrusted note, name, author and licence as plain text, and an animated preview per state', () => {
    const { urls, live } = fakeUrls();
    const view = render(<SkinImportDialog spec={{ kind: 'skinImport', staged, urls }} onDone={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: '스킨 가져오기' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('다른 사람이 만든 파일이에요. 미리 보고 라이선스를 확인하세요.');
    expect(screen.getByText('Pipette <b>Pal</b>')).toBeTruthy();
    expect(dialog.querySelector('b')).toBeNull();
    expect(screen.getByText('Kim')).toBeTruthy();
    expect(screen.getByText('CC-BY-4.0')).toBeTruthy();
    const sprites = dialog.querySelectorAll<HTMLElement>('.pet-sprite');
    expect(sprites).toHaveLength(4);
    const sheet = sprites[0].style.getPropertyValue('--pet-sheet');
    expect(sheet.startsWith('url("blob:test/') && sheet.endsWith('")')).toBe(true);
    expect(sprites[2].style.getPropertyValue('--pet-frames')).toBe('6');
    expect(sprites[2].style.getPropertyValue('--pet-dur')).toBe('1000ms');
    expect(sprites[0].getAttribute('style')).not.toContain('<');
    expect(live.size).toBe(4);
    view.unmount();
    expect(live.size, 'blob URLs revoked on close').toBe(0);
  });

  it('traps Tab inside and Escape cancels', () => {
    const onCancel = vi.fn();
    const { urls } = fakeUrls();
    render(<SkinImportDialog spec={{ kind: 'skinImport', staged, urls }} onDone={() => {}} onCancel={onCancel} />);
    const dialog = screen.getByRole('dialog');
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('importSkinFile flow', () => {
  function setup(install: (args?: Record<string, unknown>) => unknown = () => manifest) {
    const notes: Array<[string, string]> = [];
    const setSkin = vi.fn();
    const { urls } = fakeUrls();
    const fake = fakeInvoke((cmd, args) => {
      if (cmd === 'skin_import_pick') return staged;
      if (cmd === 'skin_install') return install(args);
      if (cmd === 'skin_staging_discard') return true;
      return null;
    });
    render(<DialogLayer />);
    const run = importSkinFile({ invoke: fake.invoke, urls, setSkin, notify: (k, m) => void notes.push([k, m]) });
    return { ...fake, notes, setSkin, run };
  }
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

  it('never installs without the explicit confirm; Escape on the preview drops the staging entry', async () => {
    const s = setup();
    await screen.findByRole('dialog', { name: '스킨 가져오기' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(await s.run).toBeUndefined();
    expect(s.calls.map((c) => c[0])).toEqual(['skin_import_pick', 'skin_staging_discard']);
    expect(s.calls[1][1]).toEqual({ stagingId: staged.stagingId });
    expect(s.setSkin).not.toHaveBeenCalled();
  });

  it('declining the confirm installs nothing and drops the staging entry', async () => {
    const s = setup();
    await screen.findByRole('dialog', { name: '스킨 가져오기' });
    click('설치');
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('Pipette <b>Pal</b> (Kim, CC-BY-4.0) 스킨을 설치할까요?');
    click('취소');
    expect(await s.run).toBeUndefined();
    expect(s.calls.map((c) => c[0])).toEqual(['skin_import_pick', 'skin_staging_discard']);
  });

  it('install after confirm switches to the new skin and says so', async () => {
    const s = setup();
    await screen.findByRole('dialog', { name: '스킨 가져오기' });
    click('설치');
    await screen.findByRole('alertdialog');
    click('설치');
    expect(await s.run).toEqual(manifest);
    expect(s.calls.map((c) => c[0])).toEqual(['skin_import_pick', 'skin_install']);
    expect(s.calls[1][1]).toEqual({ stagingId: staged.stagingId, replace: false });
    expect(s.setSkin).toHaveBeenCalledWith('pipette-pal');
    expect(s.notes).toEqual([['info', 'Pipette <b>Pal</b> 스킨을 설치했어요.']]);
  });

  it('the same id already installed asks before replacing', async () => {
    const s = setup((args) => {
      if (!args?.replace) throw { kind: 'exists', detail: 'pipette-pal' };
      return manifest;
    });
    await screen.findByRole('dialog', { name: '스킨 가져오기' });
    click('설치');
    await screen.findByRole('alertdialog');
    click('설치');
    await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('바꿀까요'));
    click('바꾸기');
    expect(await s.run).toEqual(manifest);
    expect(s.calls.filter((c) => c[0] === 'skin_install').map((c) => c[1])).toEqual([
      { stagingId: staged.stagingId, replace: false },
      { stagingId: staged.stagingId, replace: true },
    ]);
  });

  it('a refused file (over 2 MiB, bad pack) shows why and opens no dialog; cancel says nothing', async () => {
    const notes: Array<[string, string]> = [];
    const big = fakeInvoke(() => {
      throw { kind: 'tooLarge' };
    });
    render(<DialogLayer />);
    expect(await importSkinFile({ invoke: big.invoke, notify: (k, m) => void notes.push([k, m]) })).toBeUndefined();
    expect(notes).toEqual([['warn', '스킨 파일을 열 수 없어요. 파일이 너무 커요.']]);
    expect(screen.queryByRole('dialog')).toBeNull();
    const cancel = fakeInvoke(() => null);
    expect(await importSkinFile({ invoke: cancel.invoke, notify: (k, m) => void notes.push([k, m]) })).toBeUndefined();
    expect(notes).toHaveLength(1);
  });
});

describe('exportSkinFile', () => {
  it('saved, cancelled and refused', async () => {
    const notes: Array<[string, string]> = [];
    const notify = (k: 'info' | 'warn', m: string) => void notes.push([k, m]);
    expect(await exportSkinFile('flasko', { invoke: fakeInvoke(() => true).invoke, notify })).toBe(true);
    expect(await exportSkinFile('flasko', { invoke: fakeInvoke(() => false).invoke, notify })).toBe(false);
    const bad = fakeInvoke(() => {
      throw { kind: 'tampered' };
    });
    expect(await exportSkinFile('x-skin', { invoke: bad.invoke, notify })).toBe(false);
    expect(notes).toEqual([
      ['info', '스킨 파일을 저장했어요.'],
      ['warn', `스킨 파일을 저장하지 못했어요. ${catalogs.ko['skin.error.tampered']}`],
    ]);
  });
});

describe('skins.import and skins.export commands', () => {
  beforeEach(() => registerAllAppCommands());
  afterEach(() => clearAppCommandsForTest());

  it('are registered with ko and en names and icons, and run from the palette', async () => {
    for (const id of ['skins.import', 'skins.export']) {
      const c = appCommandById(id);
      expect(c, id).toBeTruthy();
      expect(catalogs.ko[c!.nameKey]).toBeTruthy();
      expect(catalogs.en[c!.nameKey]).toBeTruthy();
      expect(c!.icon).toBeTruthy();
    }
    const spy = vi.mocked(tauriInvoke);
    spy.mockClear();
    const notes: Array<[string, string]> = [];
    const ctx = { host: { notify: (k: string, m: string) => void notes.push([k, m]) } } as unknown as CommandContext;
    layoutStore.setPet({ skin: 'not-installed' });
    await appCommandById('skins.export')!.run(ctx);
    // An active skin that is not installed shows as the built-in one, so that is what is exported.
    expect(spy).toHaveBeenCalledWith('skin_export', { id: 'flasko' });
    await appCommandById('skins.import')!.run(ctx);
    expect(spy).toHaveBeenCalledWith('skin_import_pick', {});
    expect(notes).toEqual([['info', '스킨 파일을 저장했어요.']]);
    layoutStore.setPet({ skin: 'flasko' });
  });

  it('no style prop or attribute in the dialog source', () => {
    const src = readFileSync('src/assistant/skins/ImportDialog.tsx', 'utf-8');
    expect(src).not.toMatch(/style=\{|style="|<style/);
  });
});
