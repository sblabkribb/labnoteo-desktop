// @vitest-environment jsdom
import { MemFileSystem, type EditTarget } from '@labnoteo/core';
import type { AppFs } from '../../../fs/tauriLabnoteFs';
import { setLang } from '../../../i18n/lang';
import { createAppHost } from '../createAppHost';
import { closeAllDialogs, currentDialog, settleDialog } from '../dialogStore';
import { clearToasts, currentToasts } from '../toastStore';

function memAppFs(): AppFs {
  return Object.assign(new MemFileSystem(), {
    rename: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
  }) as unknown as AppFs;
}

const make = (over: Partial<Parameters<typeof createAppHost>[0]> = {}) =>
  createAppHost({ fs: memAppFs(), editTarget: () => undefined, openFile: vi.fn(async () => {}), ...over });

afterEach(() => {
  closeAllDialogs();
  clearToasts();
  setLang('ko');
});

describe('createAppHost', () => {
  it('createAppHost.t follows setLang', () => {
    const host = make();
    setLang('ko');
    expect(host.t('Create experiment')).toBe('실험 생성');
    setLang('en');
    expect(host.t('Create experiment')).toBe('Create experiment');
  });

  it('createAppHost.pick goes through the dialog store', async () => {
    const host = make();
    const p = host.pick(
      [
        { label: 'a', value: 1 },
        { label: 'b', value: 2 },
      ],
      { title: 'T', selected: 2 },
    );
    const d = currentDialog();
    expect(d?.spec).toMatchObject({ kind: 'pick', title: 'T', selected: 2 });
    settleDialog(d!.id, 2);
    await expect(p).resolves.toBe(2);
  });

  it('pickMany, prompt, confirm and alias queue their dialogs and resolve the cancel values when closed', async () => {
    const host = make();
    const many = host.pickMany([{ label: 'a', value: 1 }]);
    const prompt = host.prompt({ title: 'p' });
    const confirm = host.confirm('지울까요?', { destructive: true });
    const alias = host.alias({ id: 'WT010', catalogName: 'N', title: 't' });
    expect(currentDialog()?.spec.kind).toBe('pickMany');
    closeAllDialogs();
    await expect(many).resolves.toEqual([]);
    await expect(prompt).resolves.toBeUndefined();
    await expect(confirm).resolves.toBe(false);
    await expect(alias).resolves.toBeUndefined();
  });

  it('alias opens an alias dialog carrying its options', async () => {
    const host = make();
    const p = host.alias({ id: 'WT010', catalogName: 'N', title: 't', value: 'v' });
    const d = currentDialog();
    expect(d?.spec).toMatchObject({ kind: 'alias', opts: { id: 'WT010', catalogName: 'N', value: 'v' } });
    settleDialog(d!.id, '');
    await expect(p).resolves.toBe('');
  });

  it('notify goes to the toast store', () => {
    const host = make();
    host.notify('warn', '조심');
    expect(currentToasts()).toEqual([expect.objectContaining({ kind: 'warn', message: '조심' })]);
  });

  it('fs, editTarget and openFile are the ones passed in', async () => {
    const fs = memAppFs();
    const target = { getText: () => 'x' } as unknown as EditTarget;
    let current: EditTarget | undefined;
    const openFile = vi.fn(async () => {});
    const host = createAppHost({ fs, editTarget: () => current, openFile });
    expect(host.fs).toBe(fs);
    expect(host.editTarget()).toBeUndefined();
    current = target;
    expect(host.editTarget()).toBe(target);
    await host.openFile('a.md', { line: 3 });
    expect(openFile).toHaveBeenCalledWith('a.md', { line: 3 });
  });
});
