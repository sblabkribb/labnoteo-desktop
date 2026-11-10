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
import { focusableIn } from '../../../ui/focusable';
import { SkinEditorDialog, openSkinEditor, type SkinEditorDeps } from '../SkinEditor';
import {
  FPS_MAX,
  FRAMES_MAX,
  buildSkin,
  draftErrors,
  emptyEditorState,
  exportStagedSkin,
  pickSheet,
  toDraft,
  withSheet,
  type PickedSheet,
  type SkinEditorState,
} from '../skinDraft';
import type { StagedSkin } from '../store';
import type { SkinUrls } from '../useSkin';
import { SKIN_LICENCES, SKIN_STATES, type SkinManifest } from '../types';
import { BUILTIN_SKIN } from '../builtin';

vi.mock('../../../ui/SettingsModal', () => ({ openSettings: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const PNG = [0x89, 0x50, 0x4e, 0x47];
const sheet = (token: string, width = 128, height = 32): PickedSheet => ({ sheetToken: token, width, height, bytes: PNG });

function filled(): SkinEditorState {
  let s = emptyEditorState();
  s = { ...s, name: 'Pipette Pal', author: 'Kim', licence: 'CC-BY-4.0' };
  for (const st of SKIN_STATES) s = withSheet(s, st, sheet(`tok-${st}`));
  return s;
}

const manifest: SkinManifest = { ...BUILTIN_SKIN, id: 'pipette-pal', name: 'Pipette Pal', author: 'Kim', licence: 'CC-BY-4.0' };
const staged: StagedSkin = { stagingId: 'cd'.repeat(16), manifest, sheets: { idle: PNG, talk: PNG, think: PNG, done: PNG } };

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

describe('skin draft (Task 18)', () => {
  it('licence is required and limited to the allowlist', () => {
    const s = filled();
    expect(draftErrors(s)).toEqual({});
    expect(draftErrors({ ...s, licence: '' }).licence).toBe('라이선스가 필요해요.');
    expect(draftErrors({ ...s, licence: 'GPL-3.0' as never }).licence).toBeTruthy();
    for (const l of SKIN_LICENCES) expect(draftErrors({ ...s, licence: l }).licence).toBeUndefined();
  });

  it('name, author and number bounds', () => {
    const s = filled();
    expect(draftErrors({ ...s, name: '  ' }).name).toBeTruthy();
    expect(draftErrors({ ...s, name: 'x'.repeat(41) }).name).toBeTruthy();
    expect(draftErrors({ ...s, author: '' }).author).toBeTruthy();
    expect(draftErrors({ ...s, frame: { width: 15, height: 32 } }).frame).toBeTruthy();
    expect(draftErrors({ ...s, frame: { width: 32, height: 97 } }).frame).toBeTruthy();
    const st = (frames: number, fps: number) => ({ ...s, states: { ...s.states, talk: { ...s.states.talk, frames, fps } } });
    expect(draftErrors(st(0, 4))['talk.frames']).toBeTruthy();
    expect(draftErrors(st(FRAMES_MAX + 1, 4))['talk.frames']).toBeTruthy();
    expect(draftErrors(st(1.5, 4))['talk.frames']).toBeTruthy();
    expect(draftErrors(st(4, 0))['talk.fps']).toBeTruthy();
    expect(draftErrors(st(4, FPS_MAX + 1))['talk.fps']).toBeTruthy();
    expect(draftErrors(st(4, FPS_MAX))['talk.fps']).toBeUndefined();
  });

  it('a sheet whose width is not frame x frames is reported for that state in ko and en', () => {
    const s = withSheet(filled(), 'think', sheet('tok-think', 100, 32));
    expect(draftErrors(s)['think.sheet']).toBe('그림 크기(100×32)가 맞지 않아요. 128×32이어야 해요.');
    setLang('en');
    expect(draftErrors(s)['think.sheet']).toBe('The image is 100×32; it must be 128×32.');
    expect(draftErrors({ ...s, states: { ...s.states, idle: { frames: 4, fps: 4 } } })['idle.sheet']).toBe('Choose a PNG.');
  });

  it('picking a sheet guesses the frame count from the frame width', () => {
    let s = emptyEditorState();
    s = withSheet(s, 'think', sheet('t', 192, 32));
    expect(s.states.think.frames).toBe(6);
    // A first sheet of another height sets a square frame of that height.
    let t = withSheet(emptyEditorState(), 'idle', sheet('i', 192, 48));
    expect(t.frame).toEqual({ width: 48, height: 48 });
    expect(t.states.idle.frames).toBe(4);
    t = withSheet(t, 'talk', sheet('k', 96, 32));
    expect(t.frame, 'later sheets do not change the frame').toEqual({ width: 48, height: 48 });
  });

  it('the draft carries tokens and numbers only, never bytes', () => {
    const d = toDraft(filled())!;
    expect(d).toEqual({
      name: 'Pipette Pal',
      author: 'Kim',
      licence: 'CC-BY-4.0',
      frame: { width: 32, height: 32 },
      states: {
        idle: { sheetToken: 'tok-idle', frames: 4, fps: 6 },
        talk: { sheetToken: 'tok-talk', frames: 4, fps: 6 },
        think: { sheetToken: 'tok-think', frames: 4, fps: 6 },
        done: { sheetToken: 'tok-done', frames: 4, fps: 6 },
      },
    });
    expect(JSON.stringify(d)).not.toContain('bytes');
    expect(toDraft({ ...filled(), description: ' Mine ' })!.description).toBe('Mine');
    expect(toDraft({ ...filled(), licence: '' })).toBeNull();
  });

  it('IPC sends only a draft, a staging id or nothing', async () => {
    const { invoke, calls } = fakeInvoke((cmd) => (cmd === 'skin_pick_sheet' ? sheet('x') : cmd === 'skin_build' ? staged : true));
    expect(await pickSheet(invoke)).toEqual(sheet('x'));
    const draft = toDraft(filled())!;
    expect(await buildSkin(draft, invoke)).toEqual(staged);
    expect(await exportStagedSkin(staged.stagingId, invoke)).toBe(true);
    expect(calls).toEqual([
      ['skin_pick_sheet', {}],
      ['skin_build', { draft }],
      ['skin_export_staged', { stagingId: staged.stagingId }],
    ]);
    const refused = fakeInvoke(() => {
      throw { kind: 'stagingUnknown', detail: 'talk' };
    });
    await expect(buildSkin(draft, refused.invoke)).rejects.toMatchObject({ kind: 'stagingUnknown', detail: 'talk' });
  });
});

describe('SkinEditorDialog', () => {
  function setup(handler: (cmd: string, args?: Record<string, unknown>) => unknown, extra: Partial<SkinEditorDeps> = {}) {
    const fake = fakeInvoke(handler);
    const { urls, live } = fakeUrls();
    const notes: Array<[string, string]> = [];
    const setSkin = vi.fn();
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const deps: SkinEditorDeps = { invoke: fake.invoke, urls, setSkin, notify: (k, m) => void notes.push([k, m]), reducedMotion: false, ...extra };
    const view = render(<SkinEditorDialog spec={{ kind: 'skinEditor', deps }} onDone={onDone} onCancel={onCancel} />);
    return { ...fake, urls, live, notes, setSkin, onDone, onCancel, view };
  }
  let picks = 0;
  const picker = (w = 128) => () => sheet(`tok-${++picks}`, w, 32);
  const handlerWith =
    (more: Record<string, (args?: Record<string, unknown>) => unknown> = {}, pickW = 128) =>
    (cmd: string, args?: Record<string, unknown>) => {
      if (more[cmd]) return more[cmd](args);
      if (cmd === 'skin_pick_sheet') return picker(pickW)();
      if (cmd === 'skin_build') return staged;
      if (cmd === 'skin_install') return manifest;
      if (cmd === 'skin_export_staged') return true;
      if (cmd === 'skin_staging_discard') return true;
      return null;
    };
  const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  async function pickAll() {
    for (const btn of screen.getAllByRole('button', { name: /PNG 고르기/ })) {
      fireEvent.click(btn);
      await act(async () => undefined);
    }
  }
  async function fillForm() {
    type('이름', 'Pipette Pal');
    type('만든 사람', 'Kim');
    fireEvent.change(screen.getByLabelText('라이선스'), { target: { value: 'CC-BY-4.0' } });
    await pickAll();
  }

  it('is named, focus-trapped, starts on the name field, and Escape cancels', () => {
    const s = setup(handlerWith());
    const dialog = screen.getByRole('dialog', { name: '내 스킨 만들기' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('이름'));
    const f = focusableIn(dialog);
    f[f.length - 1].focus();
    fireEvent.keyDown(f[f.length - 1], { key: 'Tab' });
    expect(document.activeElement).toBe(f[0]);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(s.onCancel).toHaveBeenCalledTimes(1);
  });

  it('every control is a labelled native control reachable by Tab, in reading order', () => {
    setup(handlerWith());
    const dialog = screen.getByRole('dialog');
    const f = focusableIn(dialog);
    const names = f.map((el) => el.getAttribute('aria-label') ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent);
    for (const [i, n] of names.entries()) expect(n, `control ${i} has a name`).toBeTruthy();
    expect(f.every((el) => ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(el.tagName))).toBe(true);
    // Name, author, licence, description, frame width, frame height, then four states (pick, frames, fps), then actions.
    const order = f.map((el) => el.id || el.textContent);
    expect(order.indexOf(screen.getByLabelText('이름').id)).toBeLessThan(order.indexOf(screen.getByLabelText('라이선스').id));
    expect(screen.getAllByRole('button', { name: /PNG 고르기/ })).toHaveLength(4);
    expect(screen.getByRole('button', { name: '설치' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '내보내기' })).toBeTruthy();
  });

  it('licence select offers only the allowlist plus an empty choice', () => {
    setup(handlerWith());
    const sel = screen.getByLabelText('라이선스') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['', ...SKIN_LICENCES]);
  });

  it('install with missing fields shows inline errors, focuses the first and calls nothing', async () => {
    const s = setup(handlerWith());
    fireEvent.click(screen.getByRole('button', { name: '설치' }));
    await act(async () => undefined);
    const name = screen.getByLabelText('이름');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
    const errId = name.getAttribute('aria-describedby')!;
    expect(document.getElementById(errId.split(' ').pop()!)!.textContent).toBe('이름을 적어 주세요.');
    expect(screen.getByRole('dialog').textContent).toContain('라이선스가 필요해요.');
    expect(s.calls).toEqual([]);
  });

  it('a mismatched sheet shows the size error inline next to its state', async () => {
    setup(handlerWith({}, 100));
    fireEvent.click(screen.getAllByRole('button', { name: /PNG 고르기/ })[0]);
    await screen.findByText('그림 크기(100×32)가 맞지 않아요. 128×32이어야 해요.');
  });

  it('preview: a blob URL per picked sheet; fps and frames change CSS custom properties through CSSOM', async () => {
    const s = setup(handlerWith());
    await pickAll();
    const sprites = screen.getByRole('dialog').querySelectorAll<HTMLElement>('.pet-sprite');
    expect(sprites).toHaveLength(4);
    expect(s.live.size).toBe(4);
    const talk = sprites[1];
    const sheetVar = talk.style.getPropertyValue('--pet-sheet');
    expect(sheetVar.startsWith('url("blob:test/') && sheetVar.endsWith('")'), sheetVar).toBe(true);
    expect(talk.style.getPropertyValue('--pet-dur')).toBe('667ms');
    fireEvent.change(screen.getByLabelText('초당 칸 (말할 때)'), { target: { value: '12' } });
    expect(talk.style.getPropertyValue('--pet-dur')).toBe('333ms');
    fireEvent.change(screen.getByLabelText('한 칸 너비(px)'), { target: { value: '64' } });
    expect(talk.style.getPropertyValue('--pet-w')).toBe('64px');
    // Picking again revokes the old URL.
    fireEvent.click(screen.getAllByRole('button', { name: /PNG 고르기/ })[1]);
    await act(async () => undefined);
    expect(s.live.size).toBe(4);
    s.view.unmount();
    expect(s.live.size, 'all blob URLs revoked on close').toBe(0);
  });

  it('reduced motion: a frame slider per state steps the static frame', async () => {
    setup(handlerWith(), { reducedMotion: true });
    await pickAll();
    const slider = screen.getByLabelText('보이는 칸 (생각할 때)') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.max).toBe('3');
    const think = screen.getByRole('dialog').querySelectorAll<HTMLElement>('.pet-sprite')[2];
    expect(think.style.getPropertyValue('--pet-frame')).toBe('0');
    fireEvent.change(slider, { target: { value: '2' } });
    expect(think.style.getPropertyValue('--pet-frame')).toBe('2');
  });

  it('install builds in Rust (validate_pack), installs, switches to it and closes', async () => {
    const s = setup(handlerWith());
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '설치' }));
    await waitFor(() => expect(s.onDone).toHaveBeenCalledWith(manifest));
    expect(s.calls.map((c) => c[0])).toEqual(['skin_pick_sheet', 'skin_pick_sheet', 'skin_pick_sheet', 'skin_pick_sheet', 'skin_build', 'skin_install']);
    const draft = s.calls[4][1]!.draft as Record<string, unknown>;
    expect(JSON.stringify(draft)).not.toContain('bytes');
    expect(draft.licence).toBe('CC-BY-4.0');
    expect(s.calls[5][1]).toEqual({ stagingId: staged.stagingId, replace: false });
    expect(s.setSkin).toHaveBeenCalledWith('pipette-pal');
    expect(s.notes).toEqual([['info', 'Pipette Pal 스킨을 설치했어요.']]);
  });

  it('an existing skin with the same id asks inline before replacing', async () => {
    const s = setup(
      handlerWith({
        skin_install: (args) => {
          if (!args?.replace) throw { kind: 'exists', detail: 'pipette-pal' };
          return manifest;
        },
      }),
    );
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '설치' }));
    const replace = await screen.findByRole('button', { name: '바꾸기' });
    expect(screen.getByRole('dialog').textContent).toContain('같은 스킨(Pipette Pal)이 이미 있어요.');
    await waitFor(() => expect(document.activeElement).toBe(replace));
    fireEvent.click(replace);
    await waitFor(() => expect(s.onDone).toHaveBeenCalledWith(manifest));
    expect(s.calls.filter((c) => c[0] === 'skin_install').map((c) => c[1]!.replace)).toEqual([false, true]);
  });

  it('export builds, saves through the Rust dialog, drops the staged pack and stays open', async () => {
    const s = setup(handlerWith());
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    await waitFor(() => expect(s.notes).toEqual([['info', '스킨 파일을 저장했어요.']]));
    expect(s.calls.slice(4).map((c) => c[0])).toEqual(['skin_build', 'skin_export_staged', 'skin_staging_discard']);
    expect(s.onDone).not.toHaveBeenCalled();
    expect(s.setSkin).not.toHaveBeenCalled();
  });

  it('a Rust refusal (expired sheet token, bad pack) is shown in the dialog', async () => {
    setup(
      handlerWith({
        skin_build: () => {
          throw { kind: 'stagingUnknown', detail: 'talk' };
        },
      }),
    );
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: '설치' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('스킨을 만들지 못했어요. 시간이 지났어요. 파일을 다시 골라 주세요.');
  });

  it('a refused PNG says why next to its state', async () => {
    setup(
      handlerWith({
        skin_pick_sheet: () => {
          throw { kind: 'pngTooLarge', detail: 'sheet.png' };
        },
      }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: /PNG 고르기/ })[0]);
    await screen.findByText(`PNG를 열 수 없어요. ${catalogs.ko['skin.error.image']}`);
  });

  it('no style prop or attribute in the editor source', () => {
    for (const f of ['src/assistant/skins/SkinEditor.tsx', 'src/assistant/skins/skinDraft.ts']) {
      const src = readFileSync(f, 'utf-8');
      expect(src, f).not.toMatch(/style=\{|style="|<style/);
    }
  });
});

describe('openSkinEditor and the skins.editor command', () => {
  beforeEach(() => registerAllAppCommands());
  afterEach(() => clearAppCommandsForTest());

  it('opens the editor through the dialog layer; Escape resolves undefined', async () => {
    render(<DialogLayer />);
    const { invoke } = fakeInvoke(() => null);
    const run = openSkinEditor({ invoke });
    const dialog = await screen.findByRole('dialog', { name: '내 스킨 만들기' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(await run).toBeUndefined();
  });

  it('skins.editor is registered with ko and en names and an icon, and opens the editor', async () => {
    const c = appCommandById('skins.editor');
    expect(c).toBeTruthy();
    expect(catalogs.ko[c!.nameKey]).toBe('내 스킨 만들기');
    expect(catalogs.en[c!.nameKey]).toBeTruthy();
    expect(c!.icon).toBeTruthy();
    render(<DialogLayer />);
    const ctx = { host: { notify: () => undefined } } as unknown as CommandContext;
    const done = c!.run(ctx);
    const dialog = await screen.findByRole('dialog', { name: '내 스킨 만들기' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await done;
    expect(vi.mocked(tauriInvoke)).not.toHaveBeenCalled();
  });
});
