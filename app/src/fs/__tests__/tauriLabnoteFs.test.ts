import { isPathTooLongError } from '@labnoteo/core/lib/regexUtils';
import { ERROR_KINDS_FIXTURE } from '../../__tests__/fixtures';
import { TauriLabnoteFs, FsCommandError, ModifyConflictError, normalizeVaultPath } from '../tauriLabnoteFs';

type Reply = unknown | ((args: Record<string, unknown>) => unknown);

/** 커맨드 이름별 응답을 돌려주고 호출을 기록하는 가짜 invoke. 응답이 Error 면 거부한다. */
function fake(replies: Record<string, Reply[] | Reply>) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const queues = new Map<string, Reply[]>();
  for (const [k, v] of Object.entries(replies)) queues.set(k, Array.isArray(v) ? [...v] : [v]);
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    const q = queues.get(cmd);
    if (!q || q.length === 0) throw new Error(`unexpected call ${cmd}`);
    const r = q.length > 1 ? q.shift()! : q[0];
    const v = typeof r === 'function' ? (r as (a: Record<string, unknown>) => unknown)(args ?? {}) : r;
    if (v && typeof v === 'object' && 'reject' in (v as object)) throw (v as { reject: unknown }).reject;
    return v;
  };
  return { invoke: invoke as never, calls };
}

const notFound = { reject: { kind: ERROR_KINDS_FIXTURE.notFound, message: 'x' } };

describe('TauriLabnoteFs 매핑', () => {
  it('read 는 vault_read 를 경로와 함께 부른다', async () => {
    const f = fake({ vault_read: 'hi' });
    expect(await new TauriLabnoteFs(f.invoke).read('a/b.md')).toBe('hi');
    expect(f.calls).toEqual([['vault_read', { path: 'a/b.md' }]]);
  });

  it('write 는 vault_write 를 경로와 내용과 함께 부른다', async () => {
    const f = fake({ vault_write: null });
    await new TauriLabnoteFs(f.invoke).write('a.md', 'body');
    expect(f.calls).toEqual([['vault_write', { path: 'a.md', content: 'body' }]]);
  });

  it('list 는 vault_list 결과를 그대로 돌려준다 (빈 문자열은 루트)', async () => {
    const f = fake({ vault_list: [['b.md', 'a']] });
    expect(await new TauriLabnoteFs(f.invoke).list('')).toEqual(['b.md', 'a']);
    expect(f.calls).toEqual([['vault_list', { dir: '' }]]);
  });

  it('exists / mkdir / remove / rmdir 는 각자의 커맨드를 경로와 함께 부른다', async () => {
    const f = fake({ vault_exists: true, vault_mkdir: null, vault_remove: null, vault_rmdir: null });
    const fs = new TauriLabnoteFs(f.invoke);
    expect(await fs.exists('p')).toBe(true);
    await fs.mkdir('d');
    await fs.remove('p');
    await fs.rmdir('d');
    expect(f.calls).toEqual([
      ['vault_exists', { path: 'p' }],
      ['vault_mkdir', { path: 'd' }],
      ['vault_remove', { path: 'p' }],
      ['vault_rmdir', { path: 'd' }],
    ]);
  });
});

describe('TauriLabnoteFs 오류', () => {
  it('{kind,message} 거부를 kind 를 가진 Error 로 바꾼다', async () => {
    const f = fake({ vault_read: { reject: { kind: 'forbidden', message: 'nope' } } });
    const err = await new TauriLabnoteFs(f.invoke).read('x').catch((e) => e);
    expect(err).toBeInstanceOf(FsCommandError);
    expect(err.kind).toBe('forbidden');
    expect(err.message).toBe('nope');
  });

  it('notFound 는 code ENOENT 를 달아 코어의 ENOENT 판별이 통하게 한다', async () => {
    const f = fake({ vault_read: notFound });
    const err = await new TauriLabnoteFs(f.invoke).read('x').catch((e) => e);
    expect(err.code).toBe('ENOENT');
  });
});

describe('TauriLabnoteFs.modify', () => {
  it('updater 결과를 expectedBefore 와 함께 vault_modify 로 보낸다', async () => {
    const f = fake({ vault_read: 'old', vault_modify: { kind: 'ok' } });
    await new TauriLabnoteFs(f.invoke).modify('m.md', (d) => `${d}+new`);
    expect(f.calls).toEqual([
      ['vault_read', { path: 'm.md' }],
      ['vault_modify', { path: 'm.md', content: 'old+new', expectedBefore: 'old' }],
    ]);
  });

  it('파일이 없으면 updater 는 빈 문자열을 보고 expectedBefore 도 빈 문자열이다', async () => {
    const f = fake({ vault_read: notFound, vault_modify: { kind: 'ok' } });
    const seen: string[] = [];
    await new TauriLabnoteFs(f.invoke).modify('m.md', (d) => (seen.push(d), 'made'));
    expect(seen).toEqual(['']);
    expect(f.calls[1]).toEqual(['vault_modify', { path: 'm.md', content: 'made', expectedBefore: '' }]);
  });

  it('notFound 외의 읽기 오류는 그대로 올린다', async () => {
    const f = fake({ vault_read: { reject: { kind: 'escape', message: 'e' } } });
    // `CON.md` passes normalizeVaultPath; only Rust's confine refuses it.
    await expect(new TauriLabnoteFs(f.invoke).modify('CON.md', (d) => d)).rejects.toMatchObject({ kind: 'escape' });
    expect(f.calls.map((c) => c[0])).toEqual(['vault_read']);
  });

  it('Conflict 를 받으면 돌려받은 current 로 updater 를 다시 돌려 재시도한다', async () => {
    const f = fake({
      vault_read: 'v0',
      vault_modify: [
        { kind: 'conflict', current: 'v1' },
        { kind: 'conflict', current: 'v2' },
        { kind: 'ok' },
      ],
    });
    const seen: string[] = [];
    await new TauriLabnoteFs(f.invoke).modify('m.md', (d) => (seen.push(d), `${d}!`));
    expect(seen).toEqual(['v0', 'v1', 'v2']);
    const mods = f.calls.filter((c) => c[0] === 'vault_modify').map((c) => c[1]);
    expect(mods).toEqual([
      { path: 'm.md', content: 'v0!', expectedBefore: 'v0' },
      { path: 'm.md', content: 'v1!', expectedBefore: 'v1' },
      { path: 'm.md', content: 'v2!', expectedBefore: 'v2' },
    ]);
    // 재시도 때 다시 읽지 않는다: current 가 이미 최신이다.
    expect(f.calls.filter((c) => c[0] === 'vault_read')).toHaveLength(1);
  });

  it('다섯 번 모두 Conflict 면 조용히 성공하지 않고 ModifyConflictError 로 거부한다', async () => {
    let n = 0;
    const f = fake({ vault_read: 'v0', vault_modify: () => ({ kind: 'conflict', current: `v${++n}` }) });
    const err = await new TauriLabnoteFs(f.invoke).modify('m.md', (d) => `${d}!`).catch((e) => e);
    expect(err).toBeInstanceOf(ModifyConflictError);
    expect(err.path).toBe('m.md');
    expect(f.calls.filter((c) => c[0] === 'vault_modify')).toHaveLength(5);
  });

  it('updater 가 던지면 아무것도 쓰지 않고 그대로 올린다', async () => {
    const f = fake({ vault_read: 'v0', vault_modify: { kind: 'ok' } });
    await expect(
      new TauriLabnoteFs(f.invoke).modify('m.md', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(f.calls.map((c) => c[0])).toEqual(['vault_read']);
  });
});

describe('normalizeVaultPath', () => {
  it.each([
    ['.', ''],
    ['./', ''],
    ['', ''],
    ['./labnote', 'labnote'],
    ['labnote/./001_A', 'labnote/001_A'],
    ['a\\b', 'a/b'],
    ['a/b/', 'a/b'],
    ['labnote/001_A/README.labnote.md', 'labnote/001_A/README.labnote.md'],
  ])('%j -> %j', (input, out) => {
    expect(normalizeVaultPath(input)).toBe(out);
  });

  it.each(['../x', '..', 'a/../../x', 'a/..', '.\\..\\x', '/a', '\\\\server\\x'])('%j escapes the root and throws escape', (input) => {
    let err: unknown;
    try {
      normalizeVaultPath(input);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FsCommandError);
    expect((err as FsCommandError).kind).toBe(ERROR_KINDS_FIXTURE.escape);
  });
});

describe("TauriLabnoteFs 의 '.' 경로 (코어 로더는 루트로 '.' 를 넘긴다)", () => {
  it("list('.') 는 vault_list 를 {dir: ''} 로 부른다", async () => {
    const f = fake({ vault_list: [['labnote']] });
    expect(await new TauriLabnoteFs(f.invoke).list('.')).toEqual(['labnote']);
    expect(f.calls).toEqual([['vault_list', { dir: '' }]]);
  });

  it("exists('.') 는 invoke 없이 true", async () => {
    const f = fake({});
    expect(await new TauriLabnoteFs(f.invoke).exists('.')).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("mkdir('.') 는 아무것도 부르지 않는다", async () => {
    const f = fake({});
    await new TauriLabnoteFs(f.invoke).mkdir('.');
    await new TauriLabnoteFs(f.invoke).mkdir('./');
    expect(f.calls).toEqual([]);
  });

  it("'./a/./b.md' 는 모든 커맨드에서 'a/b.md' 로 간다", async () => {
    const f = fake({
      vault_read: 'x',
      vault_write: null,
      vault_exists: true,
      vault_mkdir: null,
      vault_remove: null,
      vault_rmdir: null,
      vault_rename: null,
      vault_trash: null,
      vault_modify: { kind: 'ok' },
    });
    const fs = new TauriLabnoteFs(f.invoke);
    await fs.read('./a/./b.md');
    await fs.write('./a/b.md', 'c');
    await fs.exists('a\\b.md');
    await fs.mkdir('./a');
    await fs.remove('./a/b.md');
    await fs.rmdir('./a');
    await fs.rename('./a/b.md', './a/./c.md');
    await fs.trash('./a/c.md');
    await fs.modify('./a/b.md', (d) => d);
    expect(f.calls).toEqual([
      ['vault_read', { path: 'a/b.md' }],
      ['vault_write', { path: 'a/b.md', content: 'c' }],
      ['vault_exists', { path: 'a/b.md' }],
      ['vault_mkdir', { path: 'a' }],
      ['vault_remove', { path: 'a/b.md' }],
      ['vault_rmdir', { path: 'a' }],
      ['vault_rename', { from: 'a/b.md', to: 'a/c.md' }],
      ['vault_trash', { path: 'a/c.md' }],
      ['vault_read', { path: 'a/b.md' }],
      ['vault_modify', { path: 'a/b.md', content: 'x', expectedBefore: 'x' }],
    ]);
  });

  it("'..' 로 루트를 벗어나는 경로는 invoke 없이 escape 로 거부한다", async () => {
    const f = fake({});
    await expect(new TauriLabnoteFs(f.invoke).read('../x')).rejects.toMatchObject({ kind: ERROR_KINDS_FIXTURE.escape });
    expect(f.calls).toEqual([]);
  });
});

describe('TauriLabnoteFs.rename / trash', () => {
  it('rename 은 {from,to}, trash 는 {path} 로 부른다', async () => {
    const f = fake({ vault_rename: null, vault_trash: null });
    const fs = new TauriLabnoteFs(f.invoke);
    await fs.rename('a.md', 'b/a.md');
    await fs.trash('b');
    expect(f.calls).toEqual([
      ['vault_rename', { from: 'a.md', to: 'b/a.md' }],
      ['vault_trash', { path: 'b' }],
    ]);
  });

  it('exists 거부는 code EEXIST 를 단다', async () => {
    const f = fake({ vault_rename: { reject: { kind: ERROR_KINDS_FIXTURE.exists, message: 'x' } } });
    const err = await new TauriLabnoteFs(f.invoke).rename('a.md', 'b.md').catch((e) => e);
    expect(err).toBeInstanceOf(FsCommandError);
    expect(err.kind).toBe('exists');
    expect(err.code).toBe('EEXIST');
  });
});

describe('TauriLabnoteFs 경로 길이 오류', () => {
  it('pathTooLong 은 code ENAMETOOLONG 이 되어 코어 isPathTooLongError 가 알아본다', async () => {
    const f = fake({ vault_write: { reject: { kind: ERROR_KINDS_FIXTURE.pathTooLong, message: 'too long' } } });
    const err = await new TauriLabnoteFs(f.invoke).write('a.md', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(FsCommandError);
    expect(err.code).toBe('ENAMETOOLONG');
    expect(isPathTooLongError(err)).toBe(true);
  });

  it('notFound 는 여전히 ENOENT 이고, 없는 파일의 modify 는 빈 문자열에서 쓴다', async () => {
    const f = fake({ vault_read: notFound, vault_modify: { kind: 'ok' } });
    const fs = new TauriLabnoteFs(f.invoke);
    const err = await fs.read('x').catch((e) => e);
    expect(err.code).toBe('ENOENT');
    expect(isPathTooLongError(err)).toBe(false);
    const seen: string[] = [];
    await fs.modify('m.md', (d) => (seen.push(d), 'made'));
    expect(seen).toEqual(['']);
  });
});
