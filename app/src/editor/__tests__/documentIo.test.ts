import { ERROR_KINDS_FIXTURE } from '../../__tests__/fixtures';
import { loadDocument, saveDocument, toRaw } from '../documentIo';

/** 가짜 보관함. Rust 의 vault_read / vault_modify 와 같은 의미: expectedBefore 가 없으면 비교하지 않는다. */
function fakeVault(files: Record<string, string>) {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const path = args.path as string;
    if (cmd === 'vault_read') {
      if (!(path in files)) throw { kind: ERROR_KINDS_FIXTURE.notFound, message: 'not found' };
      return files[path];
    }
    if (cmd === 'vault_modify') {
      const current = files[path] ?? '';
      const expected = args.expectedBefore as string | undefined;
      if (expected !== undefined && expected !== current) return { kind: 'conflict', current };
      files[path] = args.content as string;
      return { kind: 'ok' };
    }
    throw new Error(`unexpected ${cmd}`);
  }) as never;
  return { files, calls, invoke };
}

const P = 'lab/a.labnote.md';

describe('문서 읽기/쓰기', () => {
  it('CRLF 노트를 저장해도 CRLF 로 남는다', async () => {
    const v = fakeVault({ [P]: 'one\r\ntwo\r\n' });
    const doc = await loadDocument(P, v.invoke);
    // 에디터는 LF 본문을 받는다. 입력이 정말 CRLF 였음을 같이 본다.
    expect(doc.eol).toBe('crlf');
    expect(doc.text).toBe('one\ntwo\n');
    expect(await saveDocument(doc, 'one\ntwo\nthree\n', { invoke: v.invoke })).toEqual({ ok: true });
    expect(v.files[P]).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('BOM 이 있던 노트를 저장해도 BOM 이 남는다', async () => {
    const v = fakeVault({ [P]: '\uFEFFhello\n' });
    const doc = await loadDocument(P, v.invoke);
    expect(doc.hadBom).toBe(true);
    expect(doc.text).toBe('hello\n'); // 에디터에는 BOM 이 보이지 않는다
    await saveDocument(doc, 'hello!\n', { invoke: v.invoke });
    expect(v.files[P]).toBe('\uFEFFhello!\n');
  });

  it('BOM 이 없던 노트에 BOM 을 붙이지 않는다 (LF 도 그대로)', async () => {
    const v = fakeVault({ [P]: 'hello\nworld' });
    const doc = await loadDocument(P, v.invoke);
    expect(doc.hadBom).toBe(false);
    expect(doc.eol).toBe('lf');
    await saveDocument(doc, 'hello\nworld!', { invoke: v.invoke });
    expect(v.files[P]).toBe('hello\nworld!');
    expect(v.files[P].includes('\uFEFF')).toBe(false);
    expect(v.files[P].includes('\r')).toBe(false);
  });

  it('고치지 않고 저장해도 바이트가 바뀌지 않는다 (BOM + CRLF, 끝 줄바꿈 없음)', async () => {
    const raw = '\uFEFFa\r\nb';
    const v = fakeVault({ [P]: raw });
    const doc = await loadDocument(P, v.invoke);
    expect(toRaw(doc, doc.text)).toBe(raw);
  });

  it('편집 중 파일이 밖에서 바뀌었으면 저장하지 않고 conflict 를 돌려준다', async () => {
    const v = fakeVault({ [P]: 'mine\n' });
    const doc = await loadDocument(P, v.invoke);
    v.files[P] = 'theirs\n'; // 다른 프로그램이 고쳤다
    const r = await saveDocument(doc, 'mine edited\n', { invoke: v.invoke });
    expect(r).toEqual({ ok: false, reason: 'conflict', current: 'theirs\n' });
    expect(v.files[P]).toBe('theirs\n'); // 남의 변경은 그대로
    // 저장은 읽었을 때의 원문을 기대값으로 보냈다.
    expect(v.calls.at(-1)?.args.expectedBefore).toBe('mine\n');
  });

  it('conflict 이후 사용자가 덮어쓰기를 고르면 저장된다', async () => {
    const v = fakeVault({ [P]: 'mine\n' });
    const doc = await loadDocument(P, v.invoke);
    v.files[P] = 'theirs\n';
    const first = await saveDocument(doc, 'mine edited\n', { invoke: v.invoke });
    if (first.ok) throw new Error('conflict 를 기대했다');
    // 사용자는 대화상자에서 first.current 를 본 뒤 덮어쓰기를 골랐다.
    const r = await saveDocument(doc, 'mine edited\n', { force: true, against: first.current, invoke: v.invoke });
    expect(r).toEqual({ ok: true });
    expect(v.files[P]).toBe('mine edited\n');
  });

  it('덮어쓰기를 고르는 사이 또 바뀌었다면 보지 못한 변경을 덮지 않고 다시 conflict 를 돌려준다', async () => {
    const v = fakeVault({ [P]: 'mine\n' });
    const doc = await loadDocument(P, v.invoke);
    v.files[P] = 'theirs\n';
    const first = await saveDocument(doc, 'mine edited\n', { invoke: v.invoke });
    if (first.ok) throw new Error('conflict 를 기대했다');
    v.files[P] = 'third\n'; // 대화상자를 읽는 동안 세 번째 변경
    const r = await saveDocument(doc, 'mine edited\n', { force: true, against: first.current, invoke: v.invoke });
    expect(r).toEqual({ ok: false, reason: 'conflict', current: 'third\n' });
    expect(v.files[P]).toBe('third\n');
  });

  it('against 없이 force 하면 기대값을 보내지 않는다 (무조건 덮어쓰기)', async () => {
    const v = fakeVault({ [P]: 'mine\n' });
    const doc = await loadDocument(P, v.invoke);
    v.files[P] = 'theirs\n';
    expect(await saveDocument(doc, 'x\n', { force: true, invoke: v.invoke })).toEqual({ ok: true });
    expect(v.files[P]).toBe('x\n');
    expect('expectedBefore' in (v.calls.at(-1)?.args ?? {})).toBe(false);
  });

  it('줄바꿈이 섞인 노트는 한 단어를 고쳐도 다른 줄의 바이트가 바뀌지 않는다', async () => {
    const raw = 'one\r\ntwo\nthree\r\nfour\n';
    const v = fakeVault({ [P]: raw });
    const doc = await loadDocument(P, v.invoke);
    expect(doc.mixed).toBe(true); // 입력이 정말 섞여 있었다
    expect(doc.text).toBe(raw); // 섞인 파일은 정규화하지 않는다
    await saveDocument(doc, doc.text.replace('three', '3'), { invoke: v.invoke });
    expect(v.files[P]).toBe('one\r\ntwo\n3\r\nfour\n');
  });

  it('섞인 노트도 고치지 않고 저장하면 그대로이고, BOM 은 유지된다', async () => {
    const raw = '﻿a\r\nb\n';
    const v = fakeVault({ [P]: raw });
    const doc = await loadDocument(P, v.invoke);
    expect(doc.mixed).toBe(true);
    expect(toRaw(doc, doc.text)).toBe(raw);
  });

  it('섞이지 않은 CRLF 노트는 여전히 LF 본문이다 (mixed 가 아니다)', async () => {
    const doc = await loadDocument(P, fakeVault({ [P]: 'a\r\nb\r\n' }).invoke);
    expect(doc.mixed).toBe(false);
    expect(doc.text).toBe('a\nb\n');
  });
});
