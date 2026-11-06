import { createNote, noteFileName } from '../createNote';

type Call = { cmd: string; args: Record<string, unknown> };

/** 가짜 invoke: 부른 커맨드를 기록하고, 커맨드별 응답(값, 또는 `{reject}` 로 감싼 던질 값)을 돌려준다. */
function fake(replies: Record<string, unknown>) {
  const calls: Call[] = [];
  const invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    const r = replies[cmd];
    if (r instanceof Error) throw r;
    if (r && typeof r === 'object' && 'reject' in r) throw (r as { reject: unknown }).reject;
    return r;
  };
  return { calls, invoke: invoke as never };
}

const rejected = (kind: string) => ({ reject: { kind, message: kind } });

describe('노트 파일 이름', () => {
  it('항상 .labnote.md 로 끝난다', () => {
    expect(noteFileName('Day 1')).toBe('Day 1.labnote.md');
  });

  it('이미 붙인 확장자는 다시 붙이지 않는다 (.md, .labnote.md, 대소문자 무관)', () => {
    expect(noteFileName('a.labnote.md')).toBe('a.labnote.md');
    expect(noteFileName('a.md')).toBe('a.labnote.md');
    expect(noteFileName('A.LABNOTE.MD')).toBe('A.labnote.md');
  });

  it('앞뒤 공백은 버린다', () => {
    expect(noteFileName('  a  ')).toBe('a.labnote.md');
  });
});

describe('노트 만들기', () => {
  it('빈 이름은 디스크를 건드리지 않고 거절한다', async () => {
    for (const name of ['', '   ', '.md', '.labnote.md']) {
      const f = fake({});
      expect(await createNote(name, f.invoke)).toEqual({ ok: false, reason: 'empty' });
      expect(f.calls).toEqual([]);
    }
  });

  it('경로 구분자가 든 이름은 하위 폴더를 만들지 않고 거절한다', async () => {
    const backslash = String.fromCharCode(92);
    const names = ['a/b', `a${backslash}b`, '../x', '/x'];
    expect(names[1]).toHaveLength(3); // 역슬래시가 정말 한 글자로 들어 있다
    for (const name of names) {
      const f = fake({});
      expect(await createNote(name, f.invoke)).toEqual({ ok: false, reason: 'separator' });
      expect(f.calls).toEqual([]);
    }
  });

  it('점으로 시작하는 이름은 트리에 보이지 않으므로 만들지 않는다', async () => {
    const f = fake({});
    expect(await createNote('.초안', f.invoke)).toEqual({ ok: false, reason: 'invalid' });
    expect(f.calls).toEqual([]);
  });

  it('Windows 가 금지한 이름은 confine 의 거절을 알아듣는 말로 바꾼다', async () => {
    // CON 은 구분자도 점 시작도 아니므로 이 검사를 지나 vault_exists 까지 간다.
    const f = fake({ vault_exists: rejected('escape') });
    expect(await createNote('CON', f.invoke)).toEqual({ ok: false, reason: 'invalid' });
    expect(f.calls).toEqual([{ cmd: 'vault_exists', args: { path: 'CON.labnote.md' } }]);
  });

  it('같은 이름의 노트가 있으면 쓰지 않고 거절한다', async () => {
    const f = fake({ vault_exists: true });
    expect(await createNote('a', f.invoke)).toEqual({ ok: false, reason: 'exists' });
    expect(f.calls.map((c) => c.cmd)).toEqual(['vault_exists']);
  });

  it('확인과 쓰기 사이에 같은 이름이 생기면(내용이 있으면) 덮어쓰지 않는다', async () => {
    const f = fake({ vault_exists: false, vault_modify: { kind: 'conflict', current: '남의 노트' } });
    expect(await createNote('a', f.invoke)).toEqual({ ok: false, reason: 'exists' });
  });

  it('빈 노트를 만든다: 없는 파일만 만들도록 expectedBefore 를 빈 문자열로 보낸다', async () => {
    const f = fake({ vault_exists: false, vault_modify: { kind: 'ok' } });
    expect(await createNote('Day 1', f.invoke)).toEqual({ ok: true, path: 'Day 1.labnote.md' });
    expect(f.calls).toEqual([
      { cmd: 'vault_exists', args: { path: 'Day 1.labnote.md' } },
      { cmd: 'vault_modify', args: { path: 'Day 1.labnote.md', content: '', expectedBefore: '' } },
    ]);
  });

  it('그 밖의 오류는 일반 실패로 알린다', async () => {
    const f = fake({ vault_exists: false, vault_modify: rejected('io') });
    expect(await createNote('a', f.invoke)).toEqual({ ok: false, reason: 'failed' });
    const g = fake({ vault_exists: new Error('boom') });
    expect(await createNote('a', g.invoke)).toEqual({ ok: false, reason: 'failed' });
  });
});
