import { WINDOWS_PATH_MAX } from '@labnoteo/core/lib/regexUtils';
import { setLang } from '../../../i18n/lang';
import { NoteBusyError, NoteChangedError, NoteSaveError } from '../../noteErrors';
import type { CommandContext } from '../context';
import { runCommand } from '../runCommand';

function fakeCtx() {
  const notify = vi.fn();
  const ctx = { host: { notify } } as unknown as CommandContext;
  return { ctx, notify };
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe('runCommand', () => {
  it('runs a registered command with the context and shows nothing on success', async () => {
    const { ctx, notify } = fakeCtx();
    const run = vi.fn(async () => 'done');
    await runCommand(ctx, { id: 'x', nameKey: 'Create workflow', run });
    expect(run).toHaveBeenCalledWith(ctx);
    expect(notify).not.toHaveBeenCalled();
  });

  it('runCommand turns an ENAMETOOLONG rejection into the path-too-long toast', async () => {
    const { ctx, notify } = fakeCtx();
    const err = Object.assign(new Error('ENAMETOOLONG: name too long'), { code: 'ENAMETOOLONG' });
    await runCommand(ctx, async () => {
      throw err;
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const [kind, message] = notify.mock.calls[0];
    expect(kind).toBe('error');
    expect(message).toContain(String(WINDOWS_PATH_MAX - 1));
    expect(message).toMatch(/[가-힣]/); // 한국어 화면에서는 한국어
    expect(consoleError).toHaveBeenCalledWith(expect.anything(), err);
  });

  it('the Rust pathTooLong kind also gives the path-too-long toast', async () => {
    const { ctx, notify } = fakeCtx();
    await runCommand(ctx, () => Promise.reject({ kind: 'pathTooLong', message: 'too long' }));
    expect(notify.mock.calls[0][1]).toContain(String(WINDOWS_PATH_MAX - 1));
  });

  it('runCommand turns NoteBusyError, NoteSaveError and NoteChangedError into the app messages', async () => {
    const { ctx, notify } = fakeCtx();
    for (const err of [new NoteBusyError('a.md'), new NoteSaveError('a.md'), new NoteChangedError('a.md')]) {
      await runCommand(ctx, () => Promise.reject(err));
    }
    expect(notify.mock.calls.map((c) => c[1])).toEqual([
      '노트가 아직 열리는 중이거나 바깥 변경을 확인해야 해서 바꾸지 않았습니다.',
      '변경은 편집기에 들어갔지만 저장하지 못했습니다. 편집기의 안내를 따르세요.',
      '명령이 도는 동안 노트가 바뀌어 아무것도 넣지 않았습니다. 다시 실행하세요.',
    ]);
    setLang('en');
    await runCommand(ctx, () => Promise.reject(new NoteSaveError('a.md')));
    expect(notify.mock.calls[3][1]).toBe("The change is in the editor but could not be saved. Follow the editor's notice.");
  });

  it("an unknown rejection shows 'Command failed: …' and does not throw", async () => {
    const { ctx, notify } = fakeCtx();
    await expect(runCommand(ctx, () => Promise.reject(new Error('boom')))).resolves.toBeUndefined();
    await expect(runCommand(ctx, () => Promise.reject('plain'))).resolves.toBeUndefined();
    await expect(
      runCommand(ctx, {
        id: 'sync',
        nameKey: 'Create workflow',
        run: () => {
          throw new Error('sync throw');
        },
      }),
    ).resolves.toBeUndefined();
    expect(notify.mock.calls).toEqual([
      ['error', '명령 실행 실패: boom'],
      ['error', '명령 실행 실패: plain'],
      ['error', '명령 실행 실패: sync throw'],
    ]);
    setLang('en');
    await runCommand(ctx, () => Promise.reject({ kind: 'io', message: 'disk full' }));
    expect(notify.mock.calls[3]).toEqual(['error', 'Command failed: disk full']);
  });
});
