// @vitest-environment jsdom
/**
 * AI 명령이 함께 쓰는 도우미(Task 31). vendor tests/plugin/aiInsertTarget.test.ts 의 도우미 수준 사례(답 언어,
 * 빈 답, 넣을 노트 규칙)를 옮겼다: 제공자 흉내는 `fakeInvoke({ llm_chat })` 이고, 편집 대상은 진짜 편집기다.
 */
import { act, screen } from '@testing-library/react';
import { neutralizeIssueMarkers } from '@labnoteo/core';
import { fakeInvoke, netError } from '../../integrations/__tests__/fakeNet';
import { cancelProgress } from '../../integrations/progressStore';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { entryEvents } from '../../labnote/commands/entryEvents';
import { coreT } from '../../labnote/i18n';
import { closeAllDialogs, currentDialog } from '../../labnote/host/dialogStore';
import { cleanupDialogs, renderLayer } from '../../labnote/host/__tests__/harness';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { openNote } from '../../labnote/openNotes';
import type { AgentRun } from '../../labnote/port/llmAgent';
import {
  complete,
  deliverToNote,
  failureReasons,
  insertBlock,
  noteRef,
  replyLanguageInstruction,
  toolContext,
  toolRunNotice,
} from '../../labnote/port/aiCommon';
import { createAiEnv, type AiEnv } from '../aiEnv';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';
const OTHER = 'labnote/001_Test/002_WB030_B.labnote.md';
const RENAMED = 'labnote/001_Test/003_WD010_Renamed.labnote.md';
const BODY = [
  '## [WD010 A]',
  '',
  '---',
  '',
  '### [UHW010 Spin]',
  '',
  '#### Method',
  '',
  '',
  '#### Output',
  '',
  '## 결과',
  '',
  '결과 문단',
  '',
].join('\n');
const DONE = 'Inserted the summary into {0}.';
const LLM = { llmProvider: 'openai', llmEndpointOpenai: 'https://llm.example.test', llmModel: 'm' } as const;

/** OpenAI 모양의 2xx 답. */
const reply = (content: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  text: JSON.stringify({ choices: [{ message: { content, ...extra } }] }),
});

let hosts: TestHost[] = [];
function host(files: Record<string, string>, settings: Record<string, unknown> = LLM): TestHost {
  const th = createTestHost(files, settings);
  hosts.push(th);
  return th;
}

function aiEnv(th: TestHost, llmChat: (args: Record<string, unknown>) => unknown) {
  const f = fakeInvoke({ llm_chat: llmChat, net_cancel: () => null });
  return { f, env: createAiEnv(th.ctx, f.invoke) };
}

/** 편집기 한 장(진짜 CodeMirror)의 글. */
const docOf = (path: string) => openNote(path)!.view()!.state.doc.toString();

/** 명령이 하는 그대로: 답을 받고, 시작한 노트로 보낸다. */
async function askAndDeliver(env: AiEnv, path: string): Promise<void> {
  const note = noteRef(env, path);
  const result = await complete(env, [{ role: 'user', content: 'summarize' }]);
  if (!result) return;
  await deliverToNote(env, note, result.content, async (target) => void (await insertBlock(env, target, result.content)), DONE);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => setLang('en'));
afterEach(() => {
  vi.useRealTimers();
  for (const th of hosts) th.cleanup();
  hosts = [];
  cleanupDialogs();
  vi.restoreAllMocks();
});

describe('reply language', () => {
  it('replyLanguageInstruction names the UI language', () => {
    expect(replyLanguageInstruction('ko')).toContain('Write the answer in Korean.');
    expect(replyLanguageInstruction('en')).toContain('Write the answer in English.');
    expect(replyLanguageInstruction('zh-TW')).toContain('Write the answer in Chinese.');
    setLang('ko');
    expect(replyLanguageInstruction()).toContain('Write the answer in Korean.');
    // #527: a summary is not told to keep sample IDs as written
    expect(replyLanguageInstruction('en', { keepSampleIds: false })).toContain('Keep units, numbers and quoted text');
    expect(replyLanguageInstruction('en')).toContain('Keep sample IDs, units, numbers and quoted text');
  });
});

describe('tool-run notice', () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({ id: name, name, arguments: args });

  it('toolRunNotice counts changes, lookups, denials and failures', () => {
    const th = host({});
    const { env } = aiEnv(th, () => reply('x'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toolRunNotice(env, [])).toBe('The AI used no tools; nothing in the vault changed.');
    const executed: AgentRun['executed'] = [
      { call: call('edit_section'), outcome: 'done', mutates: true },
      { call: call('create_sample'), outcome: 'done', mutates: true },
      { call: call('read_note'), outcome: 'done', mutates: false },
      { call: call('write_note'), outcome: 'denied', mutates: true },
      {
        call: call('edit_section', { heading: 'Method' }),
        outcome: 'failed',
        mutates: true,
        error: 'no section',
        code: 'section_not_found',
        params: ['Method'],
      },
    ];
    const text = toolRunNotice(env, executed);
    expect(text).toContain('AI tool calls: 2 change(s) made, 1 lookup(s), 1 denied by you, 1 failed.');
    // A refusal the plugin knows is worded in the UI language (#529)
    expect(text).toContain('Failed: edit_section (Method) — The note has no "Method" section.');
    expect(text).not.toContain('Nothing in the vault changed.');
    expect(toolRunNotice(env, [{ call: call('write_note'), outcome: 'denied', mutates: true }])).toBe(
      'AI tool calls: 1 denied by you. Nothing in the vault changed.',
    );
  });

  it('failureReasons names at most 3, each cut to 80 chars', () => {
    const th = host({});
    const { env } = aiEnv(th, () => reply('x'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const long = 'x'.repeat(200);
    const executed: AgentRun['executed'] = [1, 2, 3, 4, 5].map((n) => ({
      call: call('create_sample', { alias: `a${n}` }),
      outcome: n === 5 ? 'rejected' : 'failed',
      mutates: true,
      error: long,
    }));
    const text = failureReasons(env, executed);
    expect(text.startsWith('Failed: create_sample (a1) — ')).toBe(true);
    expect(text).toContain('+2 more');
    expect(text).not.toContain('(a4)');
    const reasons = text.slice('Failed: '.length).split('; ').slice(0, 3);
    expect(reasons).toHaveLength(3);
    for (const r of reasons) {
      const reason = r.split(' — ')[1];
      expect(reason.length).toBe(80);
      expect(reason.endsWith('…')).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(5); // all of them go to the console
    expect(failureReasons(env, [{ call: call('read_note'), outcome: 'done', mutates: false }])).toBe('');
  });
});

describe('complete', () => {
  it('complete shows progress, sends temperature 0.2 and closes it', async () => {
    renderLayer();
    const th = host({});
    let answer!: (v: unknown) => void;
    const { f, env } = aiEnv(th, () => new Promise((r) => (answer = r)));
    let run!: Promise<unknown>;
    await act(async () => {
      run = complete(env, [{ role: 'user', content: 'hi' }]);
      await tick();
    });
    expect(screen.getByRole('dialog', { name: coreT('Contacting {0}…', 'OpenAI-compatible') })).toBeTruthy();
    await act(async () => {
      answer(reply('  the answer \n'));
      await run;
    });
    await expect(run).resolves.toMatchObject({ content: 'the answer', toolCalls: [] });
    const chat = f.calls.filter(([c]) => c === 'llm_chat');
    expect(chat).toHaveLength(1);
    expect((chat[0][1].body as { temperature: number }).temperature).toBe(0.2);
    expect(currentDialog()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(th.notes).toEqual([]);
  });

  it('complete without opts calls chat exactly as before; with contextWindow passes it on', async () => {
    const th = host({});
    const { env } = aiEnv(th, () => reply('ok'));
    const chat = vi.spyOn(env.provider!, 'chat');
    await complete(env, [{ role: 'user', content: 'hi' }]);
    expect(chat).toHaveBeenCalledTimes(1);
    const first = chat.mock.calls[0][1]!;
    expect(Object.keys(first).sort()).toEqual(['signal', 'temperature']);
    expect(first.temperature).toBe(0.2);
    await complete(env, [{ role: 'user', content: 'hi' }], { contextWindow: 4096 });
    const second = chat.mock.calls[1][1]!;
    expect(Object.keys(second).sort()).toEqual(['contextWindow', 'signal', 'temperature']);
    expect(second.contextWindow).toBe(4096);
    // an empty opts is the same as none
    await complete(env, [{ role: 'user', content: 'hi' }], {});
    expect(Object.keys(chat.mock.calls[2][1]!).sort()).toEqual(['signal', 'temperature']);
  });

  it('complete maps errors with describeLlmError and returns undefined', async () => {
    const th = host({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = aiEnv(th, () => {
      throw netError('status', { status: 401, body: 'raw-rust-text' });
    });
    await expect(complete(env, [{ role: 'user', content: 'hi' }])).resolves.toBeUndefined();
    expect(th.notes).toHaveLength(1);
    expect(th.notes[0].kind).toBe('warn');
    expect(th.notes[0].message).toContain('The API key is missing or wrong.');
    expect(th.notes[0].message).not.toContain('raw-rust-text');
    expect(currentDialog()).toBeNull();
  });

  it('complete gives the thinking-only no-answer message', async () => {
    const th = host({});
    const replies = [reply('', { reasoning_content: 'thinking hard' }), reply('   ')];
    const { env } = aiEnv(th, () => replies.shift());
    await expect(complete(env, [{ role: 'user', content: 'hi' }])).resolves.toBeUndefined();
    await expect(complete(env, [{ role: 'user', content: 'hi' }])).resolves.toBeUndefined();
    expect(th.notes).toEqual([
      { kind: 'warn', message: 'The model gave no answer (it only thought). Try again or choose another model.' },
      { kind: 'warn', message: 'The model gave no answer. Try again or choose another model.' },
    ]);
  });

  it('a cancelled complete shows nothing', async () => {
    const th = host({});
    const { f, env } = aiEnv(th, () => new Promise(() => {}));
    const run = complete(env, [{ role: 'user', content: 'hi' }]);
    await tick();
    const open = currentDialog();
    expect(open?.spec.kind).toBe('progress');
    cancelProgress((open!.spec as { id: number }).id);
    await expect(run).resolves.toBeUndefined();
    expect(th.notes).toEqual([]);
    expect(f.calls.some(([c]) => c === 'net_cancel')).toBe(true);
    expect(currentDialog()).toBeNull();
  });

  it('without a provider it says where to set one up and sends nothing', async () => {
    const th = host({}, { llmProvider: 'none' });
    const { f, env } = aiEnv(th, () => reply('x'));
    expect(env.provider).toBeNull();
    await expect(complete(env, [{ role: 'user', content: 'hi' }])).resolves.toBeUndefined();
    expect(th.notes).toEqual([{ kind: 'info', message: t('ai.configureFirst') }]);
    expect(f.calls).toEqual([]);
  });
});

describe('insert and deliver', () => {
  it('insertBlock neutralizes issue markers', async () => {
    const th = host({ [NOTE]: BODY });
    await th.mount(NOTE);
    const { env } = aiEnv(th, () => reply('x'));
    const answer = 'Spin at 4 °C. @issue;fix the rotor';
    expect(neutralizeIssueMarkers(answer)).not.toBe(answer);
    const atEnd = await insertBlock(env, th.host.editTarget()!, answer, { caret: BODY.indexOf('결과 문단') });
    expect(atEnd).toBe(false);
    const doc = docOf(NOTE);
    expect(doc).toContain(neutralizeIssueMarkers(answer));
    expect(doc).not.toContain('@issue;');
    // a block of its own after the caret's line, never splitting it (#48)
    expect(doc).toContain(`결과 문단\n\n${neutralizeIssueMarkers(answer)}\n`);
  });

  it('deliverToNote opens the answer dialog when the active path changed', async () => {
    const th = host({ [NOTE]: BODY, [OTHER]: BODY });
    await th.mount(NOTE);
    await th.mount(OTHER);
    th.setActive(NOTE);
    const { env } = aiEnv(th, () => {
      th.setActive(OTHER); // the user moved to another note while the model wrote
      return reply('- summary');
    });
    await askAndDeliver(env, NOTE);
    const open = currentDialog();
    expect(open?.spec).toMatchObject({ kind: 'aiAnswer', content: '- summary' });
    expect(docOf(NOTE)).toBe(BODY);
    expect(docOf(OTHER)).toBe(BODY);
    expect(th.vault.files()[NOTE]).toBe(BODY);

    // "Insert into note" checks again: still elsewhere → not inserted, the dialog says so
    const onInsert = (open!.spec as { onInsert: () => Promise<boolean> }).onInsert;
    await expect(onInsert()).resolves.toBe(false);
    expect(th.notes.at(-1)?.message).toBe('That note is no longer open. Copy the answer instead.');
    // back in that note → it goes in
    th.setActive(NOTE);
    await expect(onInsert()).resolves.toBe(true);
    expect(docOf(NOTE)).toContain('- summary');
    expect(docOf(OTHER)).toBe(BODY);
    closeAllDialogs();
  });

  it('deliverToNote follows a rename of the source note made while waiting', async () => {
    const th = host({ [RENAMED]: BODY });
    await th.mount(RENAMED);
    const { env } = aiEnv(th, () => {
      entryEvents.emit({
        kind: 'renamed',
        from: NOTE,
        to: RENAMED,
        isDir: false,
        files: [{ from: NOTE, to: RENAMED }],
        settled: Promise.resolve(),
      });
      return reply('- summary');
    });
    await askAndDeliver(env, NOTE);
    expect(currentDialog()).toBeNull();
    expect(docOf(RENAMED)).toContain('- summary');
    expect(th.notes).toEqual([{ kind: 'info', message: 'Inserted the summary into 003_WD010_Renamed.labnote.md.' }]);
  });

  it('a reply arriving during composition is inserted only after compositionend', async () => {
    const th = host({ [NOTE]: BODY });
    await th.mount(NOTE);
    const view = openNote(NOTE)!.view()!;
    let composing = false;
    Object.defineProperty(view, 'composing', { configurable: true, get: () => composing });
    const dispatch = vi.spyOn(view, 'dispatch');
    const { env } = aiEnv(th, () => {
      composing = true; // the user started a Hangul syllable while the model wrote
      return reply('- summary');
    });
    const run = askAndDeliver(env, NOTE);
    for (let i = 0; i < 5; i++) await tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(docOf(NOTE)).toBe(BODY);
    expect(currentDialog()).toBeNull();

    composing = false;
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    await run;
    const doc = docOf(NOTE);
    expect(doc.split('- summary').length - 1).toBe(1);
    expect(currentDialog()).toBeNull();
    expect(th.notes).toEqual([{ kind: 'info', message: 'Inserted the summary into 001_WD010_A.labnote.md.' }]);
  });

  it('a reply still blocked after 5 s of composition opens the answer dialog', async () => {
    const th = host({ [NOTE]: BODY });
    await th.mount(NOTE);
    const view = openNote(NOTE)!.view()!;
    Object.defineProperty(view, 'composing', { configurable: true, get: () => true });
    const { env } = aiEnv(th, () => reply('- summary'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = askAndDeliver(env, NOTE);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(currentDialog()).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await run;
    expect(currentDialog()?.spec).toMatchObject({ kind: 'aiAnswer', content: '- summary' });
    expect(docOf(NOTE)).toBe(BODY);
    closeAllDialogs();
  });
});

describe('toolContext', () => {
  it('agent write to a note deleted meanwhile is reported as failed, not recreated', async () => {
    const th = host({ [NOTE]: BODY });
    const { env } = aiEnv(th, () => reply('x'));
    const ctx = toolContext(env);
    expect(await ctx.fs.read(NOTE)).toBe(BODY); // the tool read it
    await th.host.fs.remove(NOTE); // then it was deleted
    await expect(ctx.writeNote!(NOTE, 'x')).rejects.toBeTruthy();
    expect(await th.host.fs.exists(NOTE)).toBe(false);
  });

  it('writes an existing closed note in place and creates only a new one', async () => {
    const readme = 'labnote/001_Test/README.labnote.md';
    const th = host({ [NOTE]: BODY, [readme]: '---\nlast_updated_date: 2000-01-01\n---\n# R\n' });
    const { env } = aiEnv(th, () => reply('x'));
    const ctx = toolContext(env);
    await ctx.writeNote!(NOTE, `${BODY}more\n`);
    expect(th.vault.files()[NOTE]).toBe(`${BODY}more\n`);
    await ctx.writeNote!(OTHER, 'new note\n');
    expect(th.vault.files()[OTHER]).toBe('new note\n');
    await ctx.writeNote!(readme, '---\nlast_updated_date: 2000-01-01\n---\n# R\n- [ ] x\n');
    expect(th.vault.files()[readme]).toContain('- [ ] x');
    expect(th.vault.files()[readme]).not.toContain('2000-01-01'); // README gets readmeStamp
    expect(ctx.locale).toBe('en');
  });

  it('an open note that is composing refuses the agent write', async () => {
    const th = host({ [NOTE]: BODY });
    await th.mount(NOTE);
    const view = openNote(NOTE)!.view()!;
    Object.defineProperty(view, 'composing', { configurable: true, get: () => true });
    const { env } = aiEnv(th, () => reply('x'));
    await expect(toolContext(env).writeNote!(NOTE, 'x')).rejects.toBeTruthy();
    expect(docOf(NOTE)).toBe(BODY);
  });
});
