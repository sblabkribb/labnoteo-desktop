/**
 * 말풍선 대화 갈래(plan Task 10): 폴더별 기록, 폴더 바꾸기, 멈추기, 보관함 바뀜, 압축, 지우기.
 * 런타임은 가짜이고 기록 저장소는 메모리의 가짜 Rust 다(폴더 → 문서, 토큰은 보관함 이름 + 폴더).
 */
import { AssistantHistoryError, emptyHistory, type HistoryDoc } from '../history';
import type { AssistantResult, AssistantRuntime, AssistantSink, AssistantTurn, PetState } from '../runtime';
import { createAssistantSession, folderOfNote, type HistoryIo } from '../useAssistantSession';

const A = 'labnote/001_A';
const B = 'labnote/002_세포';
const NOTE_A = `${A}/README.labnote.md`;
const NOTE_B = `${B}/001_WD010_x.labnote.md`;

function memoryHistory(seed: Record<string, HistoryDoc> = {}) {
  const docs = new Map(Object.entries(seed));
  let vault = 'v1';
  const writes: Array<{ folder: string; token: string; doc: HistoryDoc }> = [];
  const io: HistoryIo = {
    read: async (folder) => ({ doc: docs.get(folder) ?? emptyHistory(folder), token: `${vault}:${folder}` }),
    write: async (folder, token, doc) => {
      if (token !== `${vault}:${folder}`) throw new AssistantHistoryError('vaultChanged', 'vault changed');
      writes.push({ folder, token, doc });
      docs.set(folder, doc);
    },
    clear: async (folder) => void docs.delete(folder),
  };
  return { io, docs, writes, switchVault: (v: string) => (vault = v) };
}

const stored = (folder: string, texts: string[]): HistoryDoc => ({
  version: 1,
  folder,
  updated: 1,
  messages: texts.map((text, i) => ({ id: `${folder}-${i}`, role: i % 2 ? 'assistant' : 'user', text, ts: i })),
});

/** 차례마다 `plan` 을 부르는 가짜 런타임. 받은 차례를 남긴다. */
function runtime(plan: (turn: AssistantTurn, sink: AssistantSink, signal: AbortSignal) => Promise<Partial<AssistantResult>>) {
  const turns: AssistantTurn[] = [];
  const rt: AssistantRuntime = {
    id: 'fake',
    label: () => 'Fake',
    available: async () => ({ ok: true }),
    async run(turn, sink, signal) {
      turns.push(structuredClone(turn));
      const r = await plan(turn, sink, signal);
      return { content: '', sources: [], executed: [], tainted: false, ...r };
    },
  };
  return { rt, turns };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { seed?: Record<string, HistoryDoc>; rt?: AssistantRuntime } = {}) {
  const mem = memoryHistory(opts.seed);
  const pets: PetState[] = [];
  const confirm = vi.fn(async () => true);
  const session = createAssistantSession({
    history: mem.io,
    runtime: () => opts.rt,
    setPetState: (s) => pets.push(s),
    confirm,
    now: () => 1000,
  });
  return { session, mem, pets, confirm };
}

describe('folderOfNote', () => {
  it('is the experiment folder of a note, NFC, or null outside experiments', () => {
    expect(folderOfNote(NOTE_A)).toBe(A);
    expect(folderOfNote(`${B.normalize('NFD')}/x.md`)).toBe(B.normalize('NFC'));
    expect(folderOfNote('notes/free.md')).toBeNull();
    expect(folderOfNote(undefined)).toBeNull();
  });
});

describe('assistant session', () => {
  it('marks each saved reply answered: model text or a vault change, not a notice-only turn (2026-11-11 review)', async () => {
    const write = { call: { id: 'c', name: 'add_section', arguments: {} }, outcome: 'done' as const, mutates: true };
    const read = { call: { id: 'r', name: 'read_note', arguments: {} }, outcome: 'done' as const, mutates: false };
    const results: Array<Partial<AssistantResult>> = [
      { content: '답' },
      { content: '', executed: [write], notice: () => 'AI tools used: 1 change.' },
      { content: '', executed: [read], notice: () => 'The assistant gave no answer.' },
    ];
    const { rt } = runtime(async () => results.shift()!);
    const { session, mem } = setup({ rt });
    session.setActivePath(NOTE_A);
    await flush();
    for (const q of ['1', '2', '3']) await session.send(q);
    const saved = mem.writes.at(-1)!.doc.messages.filter((m) => m.role === 'assistant');
    expect(saved.map((m) => [m.text, m.answered])).toEqual([
      ['답', true],
      ['AI tools used: 1 change.', true],
      ['The assistant gave no answer.', false],
    ]);
  });

  it('loads the folder history, streams a reply into it and writes it back with the token it read', async () => {
    const { rt, turns } = runtime(async (_t, sink) => {
      sink.state('think');
      sink.status('노트 읽는 중: README.md');
      sink.source(1, { kind: 'note', label: 'README.md', target: NOTE_A });
      sink.state('talk');
      sink.delta('안녕 ');
      sink.delta('[1]');
      sink.state('done');
      return { content: '안녕 [1]', sources: [{ kind: 'note', label: 'README.md', target: NOTE_A }] };
    });
    const { session, mem, pets } = setup({ seed: { [A]: stored(A, ['전 질문', '전 답']) }, rt });
    session.setActivePath(NOTE_A);
    await flush();
    expect(session.get().messages.map((m) => m.text)).toEqual(['전 질문', '전 답']);
    await session.send('  새 질문 ');
    expect(turns[0]!.folder).toBe(A);
    expect(turns[0]!.history.map((m) => m.text)).toEqual(['전 질문', '전 답']);
    expect(turns[0]!.userText).toBe('새 질문');
    const msgs = session.get().messages;
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['user', '전 질문'],
      ['assistant', '전 답'],
      ['user', '새 질문'],
      ['assistant', '안녕 [1]'],
    ]);
    expect(msgs[3]!.sources).toEqual([{ kind: 'note', label: 'README.md', target: NOTE_A }]);
    expect(msgs[3]!.pending).toBe(false);
    expect(session.get().streaming).toBe(false);
    expect(pets.filter((s, i) => s !== pets[i - 1])).toEqual(['idle', 'think', 'talk', 'done']);
    expect(mem.writes).toHaveLength(1);
    expect(mem.writes[0]!.token).toBe(`v1:${A}`);
    expect(mem.writes[0]!.doc.messages.map((m) => m.text)).toEqual(['전 질문', '전 답', '새 질문', '안녕 [1]']);
    expect(mem.writes[0]!.doc.messages[3]!.sources).toHaveLength(1);
  });

  it('shows deltas while streaming and the tool status line', async () => {
    const gate = deferred();
    const { rt } = runtime(async (_t, sink) => {
      sink.status('도구 쓰는 중: x');
      sink.delta('부분');
      await gate.promise;
      return { content: '부분 끝' };
    });
    const { session } = setup({ rt });
    session.setActivePath(NOTE_A);
    await flush();
    const p = session.send('q');
    await flush();
    const reply = session.get().messages[1]!;
    expect(reply.pending).toBe(true);
    expect(reply.text).toBe('부분');
    expect(session.get().streaming).toBe(true);
    gate.resolve();
    await p;
    expect(session.get().messages[1]!.text).toBe('부분 끝');
  });

  it('stop aborts the run, puts the pet to idle, marks the reply stopped and writes nothing', async () => {
    const { rt } = runtime(
      (_t, sink, signal) =>
        new Promise((resolve) => {
          sink.delta('반쯤');
          signal.addEventListener('abort', () => resolve({ cancelled: true }));
        })
    );
    const { session, mem, pets } = setup({ rt });
    session.setActivePath(NOTE_A);
    await flush();
    const p = session.send('q');
    await flush();
    session.stop();
    await p;
    expect(pets[pets.length - 1]).toBe('idle');
    expect(session.get().messages[1]!.stopped).toBe(true);
    expect(session.get().streaming).toBe(false);
    expect(mem.writes).toHaveLength(0);
  });

  it("switching to another experiment cancels the run and shows only that folder's history; A never reaches a B turn", async () => {
    let first = true;
    const { rt, turns } = runtime(
      (_t, sink, signal) =>
        new Promise((resolve) => {
          if (!first) return resolve({ content: 'B 답' });
          first = false;
          sink.delta('A 답 일부');
          signal.addEventListener('abort', () => resolve({ cancelled: true }));
        })
    );
    const { session, mem } = setup({ seed: { [A]: stored(A, ['A 비밀 질문', 'A 비밀 답']), [B]: stored(B, ['B 질문', 'B 답']) }, rt });
    session.setActivePath(NOTE_A);
    await flush();
    const p = session.send('A 새 질문');
    await flush();
    session.setActivePath(NOTE_B);
    await p;
    await flush();
    expect(session.get().folder).toBe(B);
    expect(session.get().streaming).toBe(false);
    const shown = JSON.stringify(session.get().messages);
    expect(shown).not.toContain('A ');
    expect(session.get().messages.map((m) => m.text)).toEqual(['B 질문', 'B 답']);
    expect(mem.writes).toHaveLength(0);

    await session.send('B 새 질문');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.folder).toBe(B);
    expect(JSON.stringify(turns[1])).not.toContain('A ');
    expect(mem.writes.map((w) => w.folder)).toEqual([B]);
    expect(JSON.stringify(mem.writes[0]!.doc)).not.toContain('A ');
  });

  it('a slow history read of A that lands after switching to B is ignored', async () => {
    const mem = memoryHistory({ [A]: stored(A, ['A 글']), [B]: stored(B, ['B 글']) });
    const gate = deferred();
    const io: HistoryIo = {
      ...mem.io,
      read: async (folder) => {
        if (folder === A) await gate.promise;
        return mem.io.read(folder);
      },
    };
    const session = createAssistantSession({ history: io, setPetState: () => {} });
    session.setActivePath(NOTE_A);
    session.setActivePath(NOTE_B);
    await flush();
    gate.resolve();
    await flush();
    expect(session.get().messages.map((m) => m.text)).toEqual(['B 글']);
  });

  it('outside an experiment the chat is ephemeral: it works, keeps its own turns and writes nothing', async () => {
    const { rt, turns } = runtime(async () => ({ content: '답' }));
    const { session, mem } = setup({ rt });
    session.setActivePath('notes/free.md');
    expect(session.get().folder).toBeNull();
    await session.send('하나');
    await session.send('둘');
    expect(turns[1]!.folder).toBeNull();
    expect(turns[1]!.history.map((m) => m.text)).toEqual(['하나', '답']);
    expect(mem.writes).toHaveLength(0);
  });

  it('a vaultChanged refusal drops the write, shows the notice and keeps the session usable', async () => {
    const { rt } = runtime(async () => ({ content: '답' }));
    const { session, mem } = setup({ rt });
    session.setActivePath(NOTE_A);
    await flush();
    mem.switchVault('v2');
    await session.send('q');
    expect(mem.writes).toHaveLength(0);
    expect(session.get().notice).toBe('보관함이 바뀌어서 이 대화는 저장하지 않았어요.');
    expect(session.get().streaming).toBe(false);
    await session.send('again');
    expect(session.get().messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(mem.writes).toHaveLength(0);
  });

  it('an error result shows in the reply and is not saved', async () => {
    const { rt } = runtime(async () => ({ error: '모델 오류' }));
    const { session, mem, pets } = setup({ rt });
    session.setActivePath(NOTE_A);
    await flush();
    await session.send('q');
    expect(session.get().messages[1]!.error).toBe('모델 오류');
    expect(pets[pets.length - 1]).toBe('idle');
    expect(mem.writes).toHaveLength(0);
  });

  it('an error with a detail (the repeated part of a reasoning loop) keeps the detail on the reply, unsaved', async () => {
    const detail = { label: 'Show the repeated part', text: 'again and again' };
    const { rt } = runtime(async () => ({ error: '고리', errorDetail: detail }));
    const { session, mem } = setup({ rt });
    session.setActivePath(NOTE_A);
    await flush();
    await session.send('q');
    expect(session.get().messages[1]).toMatchObject({ error: '고리', errorDetail: detail });
    expect(mem.writes).toHaveLength(0);
  });

  it('compacts first when needed: the turn gets the summary and the saved doc keeps it', async () => {
    const { rt, turns } = runtime(async () => ({ content: '답' }));
    const mem = memoryHistory({ [A]: stored(A, ['1', '2', '3', '4']) });
    const prepare = vi.fn(async (doc: HistoryDoc) => ({
      doc: { ...doc, summary: { text: '요약', tainted: true, covers: 2 }, messages: doc.messages.slice(2) },
      compacted: true,
      failed: false,
    }));
    const session = createAssistantSession({ history: mem.io, runtime: () => rt, prepare, setPetState: () => {} });
    session.setActivePath(NOTE_A);
    await flush();
    await session.send('q');
    expect(prepare.mock.calls[0]![0].folder).toBe(A);
    expect(turns[0]!.summary).toBe('요약');
    expect(turns[0]!.summaryTainted).toBe(true);
    expect(turns[0]!.history.map((m) => m.text)).toEqual(['3', '4']);
    expect(session.get().summarised).toBe(true);
    expect(mem.writes[0]!.doc.summary?.text).toBe('요약');
    expect(mem.writes[0]!.doc.messages.map((m) => m.text)).toEqual(['3', '4', 'q', '답']);
  });

  it('clear asks first, then removes only this folder', async () => {
    const { session, mem, confirm } = setup({ seed: { [A]: stored(A, ['a']), [B]: stored(B, ['b']) } });
    session.setActivePath(NOTE_A);
    await flush();
    confirm.mockResolvedValueOnce(false);
    expect(await session.clear()).toBe(false);
    expect(mem.docs.has(A)).toBe(true);
    expect(await session.clear()).toBe(true);
    expect(confirm).toHaveBeenCalledWith('이 실험의 대화 기록을 모두 지울까요? 되돌릴 수 없어요.');
    expect(mem.docs.has(A)).toBe(false);
    expect(mem.docs.has(B)).toBe(true);
    expect(session.get().messages).toEqual([]);
  });

  it('without a runtime the reply says to configure AI first', async () => {
    const { session } = setup();
    session.setActivePath(NOTE_A);
    await flush();
    await session.send('q');
    expect(session.get().messages[1]!.error).toBe('연동 설정에서 AI 제공자를 먼저 설정하세요.');
  });
});
