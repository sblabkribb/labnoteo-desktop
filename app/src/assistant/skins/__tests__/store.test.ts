// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { InvokeFn } from '../../../integrations/netIpc';
import { BUILTIN_SKIN, BUILTIN_SKIN_ID, builtinSheetUrl } from '../builtin';
import {
  SKIN_ERROR_KINDS,
  SkinStoreError,
  installSkin,
  listSkins,
  readSkin,
  removeSkin,
  removeSkinAndFallBack,
  skinChoices,
  toSkinError,
  type SkinData,
} from '../store';
import { loadSkin, useSkin, type SkinUrls } from '../useSkin';
import type { SkinManifest } from '../types';

const blue: SkinManifest = {
  ...BUILTIN_SKIN,
  id: 'flasko-blue',
  name: 'Flasko Blue',
  author: 'Hong',
  licence: 'CC-BY-4.0',
  states: {
    idle: { sheet: 'idle.png', frames: 4, fps: 4 },
    talk: { sheet: 'talk.png', frames: 4, fps: 8 },
    think: { sheet: 'think.png', frames: 6, fps: 6 },
    done: { sheet: 'done.png', frames: 6, fps: 10 },
  },
};

const PNG = [0x89, 0x50, 0x4e, 0x47];
const data: SkinData = { manifest: blue, sheets: { idle: PNG, talk: PNG, think: PNG, done: PNG } };

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
  const revoked: string[] = [];
  const blobs: Blob[] = [];
  const urls: SkinUrls = {
    create(b) {
      blobs.push(b);
      const u = `blob:test/${++n}`;
      live.add(u);
      return u;
    },
    revoke(u) {
      live.delete(u);
      revoked.push(u);
    },
  };
  return { urls, live, revoked, blobs };
}

describe('skin store IPC', () => {
  it('maps Rust error kinds and keeps the list in step with ipc-skin-errors.json', () => {
    const fixture = JSON.parse(readFileSync('src-tauri/tests/ipc-skin-errors.json', 'utf-8')) as Record<string, string>;
    expect([...SKIN_ERROR_KINDS].sort()).toEqual(Object.values(fixture).sort());
    expect(toSkinError({ kind: 'tampered', detail: 'x' }).kind).toBe('tampered');
    expect(toSkinError({ kind: 'nope' }).kind).toBe('io');
    expect(toSkinError('boom')).toBeInstanceOf(SkinStoreError);
  });

  it('sends only ids, staging ids and flags (never bytes or paths)', async () => {
    const { invoke, calls } = fakeInvoke((cmd) => (cmd === 'skin_list' ? [blue] : cmd === 'skin_read' ? data : cmd === 'skin_install' ? blue : null));
    expect(await listSkins(invoke)).toEqual([blue]);
    expect((await readSkin('flasko-blue', invoke)).manifest.id).toBe('flasko-blue');
    expect((await installSkin('ab'.repeat(16), true, invoke)).id).toBe('flasko-blue');
    await removeSkin('flasko-blue', invoke);
    expect(calls).toEqual([
      ['skin_list', {}],
      ['skin_read', { id: 'flasko-blue' }],
      ['skin_install', { stagingId: 'ab'.repeat(16), replace: true }],
      ['skin_remove', { id: 'flasko-blue' }],
    ]);
  });

  it('turns a refusal into a SkinStoreError', async () => {
    const { invoke } = fakeInvoke(() => {
      throw { kind: 'exists', detail: 'flasko-blue' };
    });
    await expect(installSkin('x', false, invoke)).rejects.toMatchObject({ kind: 'exists' });
  });

  it('lists the built-in skin first, then installed skins', () => {
    const choices = skinChoices([blue, { ...blue, id: BUILTIN_SKIN_ID }]);
    expect(choices.map((c) => [c.id, c.builtin])).toEqual([
      [BUILTIN_SKIN_ID, true],
      ['flasko-blue', false],
    ]);
  });
});

describe('removeSkinAndFallBack', () => {
  it('never removes the built-in skin', async () => {
    const { invoke, calls } = fakeInvoke(() => null);
    const setSkin = vi.fn();
    await expect(removeSkinAndFallBack(BUILTIN_SKIN_ID, { invoke, activeSkin: () => BUILTIN_SKIN_ID, setSkin })).rejects.toMatchObject({
      kind: 'builtin',
    });
    expect(calls).toEqual([]);
    expect(setSkin).not.toHaveBeenCalled();
  });

  it('switches back to the built-in skin when the active skin is removed', async () => {
    const { invoke } = fakeInvoke(() => null);
    const setSkin = vi.fn();
    await removeSkinAndFallBack('flasko-blue', { invoke, activeSkin: () => 'flasko-blue', setSkin });
    expect(setSkin).toHaveBeenCalledWith(BUILTIN_SKIN_ID);
  });

  it('keeps another active skin', async () => {
    const { invoke } = fakeInvoke(() => null);
    const setSkin = vi.fn();
    await removeSkinAndFallBack('flasko-blue', { invoke, activeSkin: () => 'other-skin', setSkin });
    expect(setSkin).not.toHaveBeenCalled();
  });
});

describe('loadSkin / useSkin', () => {
  it('serves the built-in skin from the app itself without IPC or blob URLs', async () => {
    const { invoke, calls } = fakeInvoke(() => data);
    const u = fakeUrls();
    const s = await loadSkin(BUILTIN_SKIN_ID, { invoke, urls: u.urls });
    expect(s.manifest).toBe(BUILTIN_SKIN);
    expect(s.sheetUrl('think')).toBe(builtinSheetUrl('think'));
    expect(calls).toEqual([]);
    expect(u.blobs).toEqual([]);
  });

  it('makes one image/png blob URL per state for an installed skin', async () => {
    const { invoke } = fakeInvoke(() => data);
    const u = fakeUrls();
    const s = await loadSkin('flasko-blue', { invoke, urls: u.urls });
    expect(s.id).toBe('flasko-blue');
    expect(s.manifest).toEqual(blue);
    for (const st of ['idle', 'talk', 'think', 'done'] as const) {
      expect(s.sheetUrl(st)).toMatch(/^blob:/);
      expect(s.sheetUrl(st)).not.toMatch(/^asset:|convertFileSrc/);
    }
    expect(u.blobs.map((b) => b.type)).toEqual(['image/png', 'image/png', 'image/png', 'image/png']);
    s.dispose();
    expect(u.live.size).toBe(0);
  });

  it.each(['notFound', 'tampered', 'io'])('falls back to the built-in skin when the read fails (%s)', async (kind) => {
    const { invoke } = fakeInvoke(() => {
      throw { kind };
    });
    const u = fakeUrls();
    const s = await loadSkin('flasko-blue', { invoke, urls: u.urls });
    expect(s.id).toBe(BUILTIN_SKIN_ID);
    expect(s.manifest).toBe(BUILTIN_SKIN);
    expect(u.blobs).toEqual([]);
  });

  it('falls back when the manifest read back does not match the id', async () => {
    const { invoke } = fakeInvoke(() => ({ ...data, manifest: { ...blue, id: 'other-skin' } }));
    const u = fakeUrls();
    expect((await loadSkin('flasko-blue', { invoke, urls: u.urls })).id).toBe(BUILTIN_SKIN_ID);
    expect(u.live.size).toBe(0);
  });

  it('revokes blob URLs on switch and on unmount', async () => {
    const { invoke } = fakeInvoke((_cmd, args) => ({ ...data, manifest: { ...blue, id: String(args?.id) } }));
    const u = fakeUrls();
    const { result, rerender, unmount } = renderHook(({ id }) => useSkin(id, { invoke, urls: u.urls }), {
      initialProps: { id: 'flasko-blue' },
    });
    expect(result.current.id).toBe(BUILTIN_SKIN_ID);
    await waitFor(() => expect(result.current.id).toBe('flasko-blue'));
    const first = [...u.live];
    expect(first).toHaveLength(4);

    rerender({ id: 'skin-two' });
    await waitFor(() => expect(result.current.id).toBe('skin-two'));
    for (const url of first) expect(u.revoked).toContain(url);
    expect(u.live.size).toBe(4);

    rerender({ id: BUILTIN_SKIN_ID });
    await waitFor(() => expect(result.current.id).toBe(BUILTIN_SKIN_ID));
    expect(u.live.size).toBe(0);

    rerender({ id: 'flasko-blue' });
    await waitFor(() => expect(result.current.id).toBe('flasko-blue'));
    act(() => unmount());
    expect(u.live.size).toBe(0);
  });

  it('drops a read that finishes after the id changed', async () => {
    let release: (v: SkinData) => void = () => undefined;
    const invoke = ((cmd: string) =>
      cmd === 'skin_read' ? new Promise<SkinData>((r) => (release = r)) : Promise.resolve(null)) as InvokeFn;
    const u = fakeUrls();
    const { result, rerender } = renderHook(({ id }) => useSkin(id, { invoke, urls: u.urls }), { initialProps: { id: 'flasko-blue' } });
    rerender({ id: BUILTIN_SKIN_ID });
    await act(async () => release(data));
    expect(result.current.id).toBe(BUILTIN_SKIN_ID);
    expect(u.live.size).toBe(0);
  });
});
