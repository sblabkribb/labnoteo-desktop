import { ERROR_KINDS_FIXTURE } from '../../__tests__/fixtures';
import { TauriLabnoteFs, FsCommandError, ModifyConflictError } from '../tauriLabnoteFs';

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
    await expect(new TauriLabnoteFs(f.invoke).modify('../x', (d) => d)).rejects.toMatchObject({ kind: 'escape' });
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
