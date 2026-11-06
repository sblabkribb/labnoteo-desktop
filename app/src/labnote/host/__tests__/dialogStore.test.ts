import {
  closeAllDialogs,
  confirmDialog,
  currentDialog,
  openDialog,
  pickDialog,
  settleDialog,
  subscribeDialogs,
} from '../dialogStore';

afterEach(() => closeAllDialogs());

describe('대화상자 저장소', () => {
  it('two dialogs queue in order: 한 번에 하나만 보이고, 먼저 연 것이 먼저 끝난다', async () => {
    const first = openDialog<string>({ kind: 'prompt', opts: { title: 'A' } }, 'cancel-a');
    const second = openDialog<string>({ kind: 'prompt', opts: { title: 'B' } }, 'cancel-b');
    const a = currentDialog();
    expect(a?.spec).toMatchObject({ kind: 'prompt', opts: { title: 'A' } });
    settleDialog(a!.id, 'a');
    await expect(first).resolves.toBe('a');
    const b = currentDialog();
    expect(b?.spec).toMatchObject({ kind: 'prompt', opts: { title: 'B' } });
    settleDialog(b!.id, 'b');
    await expect(second).resolves.toBe('b');
    expect(currentDialog()).toBeNull();
  });

  it('settle 은 한 번만 듣는다: 이미 끝난 대화상자의 id 는 다음 대화상자를 끝내지 않는다', async () => {
    const first = pickDialog([{ label: 'x', value: 1 }]);
    const second = pickDialog([{ label: 'y', value: 2 }]);
    const id = currentDialog()!.id;
    settleDialog(id, 1);
    settleDialog(id, 99);
    await expect(first).resolves.toBe(1);
    expect(currentDialog()).not.toBeNull();
    settleDialog(currentDialog()!.id, 2);
    await expect(second).resolves.toBe(2);
  });

  it('closeAllDialogs 는 줄의 모두를 각자의 취소 값으로 끝낸다', async () => {
    const a = pickDialog([{ label: 'x', value: 1 }]);
    const b = confirmDialog('지울까요?');
    closeAllDialogs();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBe(false);
    expect(currentDialog()).toBeNull();
  });

  it('aborting the signal closes the confirm and resolves false (보이는 것이든 줄에서 기다리는 것이든)', async () => {
    const shown = new AbortController();
    const waiting = new AbortController();
    const a = confirmDialog('A', { signal: shown.signal });
    const b = confirmDialog('B', { signal: waiting.signal });
    const c = confirmDialog('C');
    waiting.abort();
    await expect(b).resolves.toBe(false);
    expect(currentDialog()?.spec).toMatchObject({ message: 'A' });
    shown.abort();
    await expect(a).resolves.toBe(false);
    expect(currentDialog()?.spec).toMatchObject({ message: 'C' });
    settleDialog(currentDialog()!.id, true);
    await expect(c).resolves.toBe(true);
  });

  it('이미 끊긴 signal 의 확인은 열리지 않고 바로 false', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(confirmDialog('A', { signal: ac.signal })).resolves.toBe(false);
    expect(currentDialog()).toBeNull();
  });

  it('바뀔 때마다 구독자에게 알린다', () => {
    const seen: Array<string | undefined> = [];
    const off = subscribeDialogs(() => seen.push(currentDialog()?.spec.kind));
    void pickDialog([{ label: 'x', value: 1 }]);
    settleDialog(currentDialog()!.id, 1);
    off();
    expect(seen).toEqual(['pick', undefined]);
  });
});
