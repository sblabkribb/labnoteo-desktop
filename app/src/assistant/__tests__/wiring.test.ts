// @vitest-environment jsdom
/**
 * 말풍선이 앱에 맡기는 일(plan Task 10): 출처 열기(노트는 편집기, 주소는 openExternal 로 시스템 브라우저), 답을 노트에 넣기
 * (오염된 답은 먼저 묻는다), 내장 런타임과 압축을 대화 갈래에 잇기.
 */
import type { CommandContext } from '../../labnote/commands/context';
import { getRuntime } from '../runtime';
import { createAssistantSession } from '../useAssistantSession';
import { bubbleActions, connectAssistant, openSourceWith } from '../wiring';

const insertBlock = vi.fn(async () => false);
vi.mock('../../labnote/port/aiCommon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../labnote/port/aiCommon')>();
  return { ...actual, insertBlock: (...a: unknown[]) => insertBlock(...(a as [])) };
});

function ctx(opts: { confirm?: boolean; target?: boolean } = {}) {
  const notes: Array<[string, string]> = [];
  const confirms: string[] = [];
  const target = { path: 'labnote/001_A/README.labnote.md' };
  const c = {
    settings: { llmProvider: 'none' },
    host: {
      notify: (kind: string, message: string) => void notes.push([kind, message]),
      confirm: async (message: string) => {
        confirms.push(message);
        return opts.confirm ?? true;
      },
      editTarget: () => (opts.target === false ? undefined : target),
      t: (k: string) => k,
    },
    openFile: vi.fn(async () => undefined),
  } as unknown as CommandContext;
  return { c, notes, confirms, target };
}

beforeEach(() => insertBlock.mockClear());

describe('openSourceWith', () => {
  it('opens notes in the editor and web/paper targets through the URL opener, exactly as given', async () => {
    const openFile = vi.fn();
    const openUrl = vi.fn();
    await openSourceWith({ kind: 'note', label: 'R', target: 'labnote/001_A/R.md' }, { openFile, openUrl });
    await openSourceWith({ kind: 'web', label: 'W', target: 'https://example.test/x?y=1' }, { openFile, openUrl });
    await openSourceWith({ kind: 'paper', label: 'P', target: 'https://doi.org/10.1/abc' }, { openFile, openUrl });
    expect(openFile).toHaveBeenCalledWith('labnote/001_A/R.md');
    expect(openUrl.mock.calls).toEqual([['https://example.test/x?y=1'], ['https://doi.org/10.1/abc']]);
  });

  it('refuses targets the ledger would refuse', async () => {
    const openFile = vi.fn();
    const openUrl = vi.fn();
    await openSourceWith({ kind: 'web', label: 'x', target: 'javascript:alert(1)' }, { openFile, openUrl });
    await openSourceWith({ kind: 'note', label: 'x', target: '../outside.md' }, { openFile, openUrl });
    expect(openFile).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('bubbleActions.insert', () => {
  it('inserts a clean reply into the open note without asking', async () => {
    const { c, confirms, target } = ctx();
    await bubbleActions(() => c).insert!('답', false);
    expect(confirms).toEqual([]);
    expect(insertBlock).toHaveBeenCalledTimes(1);
    expect(insertBlock.mock.calls[0]!.slice(1)).toEqual([target, '답']);
  });

  it('asks first for a tainted reply and does nothing when refused', async () => {
    const { c, confirms } = ctx({ confirm: false });
    await bubbleActions(() => c).insert!('답', true);
    expect(confirms).toEqual(['외부에서 가져온 내용을 읽은 뒤의 변경이에요. 내용을 확인해 주세요.']);
    expect(insertBlock).not.toHaveBeenCalled();
  });

  it('says to open a note when none is open', async () => {
    const { c, notes } = ctx({ target: false });
    await bubbleActions(() => c).insert!('답', false);
    expect(notes).toEqual([['info', '답을 넣을 노트를 먼저 여세요.']]);
    expect(insertBlock).not.toHaveBeenCalled();
  });
});

describe('connectAssistant', () => {
  it('registers the built-in runtime and hands it to the session until disconnected', async () => {
    const { c } = ctx();
    const session = createAssistantSession({ setPetState: () => {} });
    const off = connectAssistant(() => c, session);
    expect(getRuntime('builtin')?.id).toBe('builtin');
    session.setActivePath('notes/free.md');
    await session.send('q');
    // llmProvider 'none': the built-in runtime answers with the configure-first message
    expect(session.get().messages[1]!.error).toBe('연동 설정에서 AI 제공자를 먼저 설정하세요.');
    off();
    expect(getRuntime('builtin')).toBeUndefined();
  });
});

describe('chip actions (Task 11B)', () => {
  it('lineAt counts newlines before an offset', async () => {
    const { lineAt } = await import('../wiring');
    expect(lineAt('a\nb\nc', 0)).toBe(0);
    expect(lineAt('a\nb\nc', 2)).toBe(1);
    expect(lineAt('a\nb\nc', 99)).toBe(2);
  });

  it('activeNote reads the open note and its cursor line; nothing without an open note', async () => {
    const target = {
      path: 'labnote/001_A/001_WD010_X.labnote.md',
      getText: async () => '# x\n## y\nz',
      getCursorOffset: async () => 6,
    };
    const c = { host: { editTarget: () => target } } as unknown as CommandContext;
    await expect(bubbleActions(() => c).activeNote!()).resolves.toEqual({ path: target.path, text: '# x\n## y\nz', cursorLine: 1 });
    const none = { host: { editTarget: () => undefined } } as unknown as CommandContext;
    await expect(bubbleActions(() => none).activeNote!()).resolves.toBeUndefined();
  });

  it('workflowNotes lists the ###_….md notes of the folder in number order, without the README', async () => {
    const list = vi.fn(async () => ['README.labnote.md', '010_WD030_C.labnote.md', '002_WD020_B.labnote.md', 'notes.md', 'attachments']);
    const c = { host: { fs: { list } } } as unknown as CommandContext;
    await expect(bubbleActions(() => c).workflowNotes!('labnote/001_A/')).resolves.toEqual([
      'labnote/001_A/002_WD020_B.labnote.md',
      'labnote/001_A/010_WD030_C.labnote.md',
    ]);
    expect(list).toHaveBeenCalledWith('labnote/001_A');
  });
});
