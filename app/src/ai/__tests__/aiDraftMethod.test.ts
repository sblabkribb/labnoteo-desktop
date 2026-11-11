// @vitest-environment jsdom
/**
 * "AI: Method 초안"(Task 32). vendor tests/plugin/aiInsertTarget.test.ts 의 draftMethodCommand 사례를 옮겼다:
 * 제공자 흉내는 `fakeInvoke({ llm_chat })` 이고, 편집 대상은 진짜 편집기(testHost.mount)다.
 */
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { closeAllDialogs, currentDialog } from '../../labnote/host/dialogStore';
import { cleanupDialogs } from '../../labnote/host/__tests__/harness';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { openNote } from '../../labnote/openNotes';
import { aiDraftRanges } from '../../editor/live/aiDraftReview';
import { draftMethodCommand, toNoteCallout } from '../../labnote/port/aiDraftMethod';
import { createAiEnv } from '../aiEnv';

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';
const OTHER = 'labnote/001_Test/002_WB030_B.labnote.md';
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
const IN_METHOD = BODY.indexOf('#### Method') + 2;
const LLM = { llmProvider: 'openai', llmEndpointOpenai: 'https://llm.example.test', llmModel: 'llama3.1' } as const;
const HEADER = String.raw`> \[!note\] AI draft \(llama3\.1, \d{4}-\d{2}-\d{2}\) — review it, then delete this line`;
/** 2026-11-11: by default the draft goes in as plain Method content, with no marker line in the file. */
const IN_FILLED_METHOD = (doc: string) => doc.includes('#### Method\n\n1. 원심분리') && !doc.includes('[!note]');
const IN_MARKED_METHOD = (doc: string) => new RegExp(String.raw`#### Method\n\n${HEADER}\n\n1\. 원심분리`).test(doc);

/** OpenAI 모양의 2xx 답. */
const reply = (content: string) => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) });

type Message = { role: string; content: string };

let hosts: TestHost[] = [];
function host(files: Record<string, string>, settings: Record<string, unknown> = LLM): TestHost {
  const th = createTestHost(files, settings);
  hosts.push(th);
  return th;
}

/** 가짜 Rust 와 AiEnv. `order` 는 확인(confirm)과 llm_chat 이 불린 차례다. */
function aiEnv(th: TestHost, llmChat: (args: Record<string, unknown>) => unknown) {
  const order: string[] = [];
  const f = fakeInvoke({
    llm_chat: (args) => {
      order.push('llm_chat');
      return llmChat(args);
    },
    net_cancel: () => null,
  });
  const confirm = th.host.confirm;
  th.host.confirm = async (message, opts) => {
    order.push('confirm');
    return confirm(message, opts);
  };
  return { f, order, env: createAiEnv(th.ctx, f.invoke) };
}

/** llm_chat 로 보낸 메시지들, 차례대로. */
const sent = (f: ReturnType<typeof fakeInvoke>): Message[][] =>
  f.calls.filter(([c]) => c === 'llm_chat').map(([, a]) => (a.body as { messages: Message[] }).messages);

const docOf = (path: string) => openNote(path)!.view()!.state.doc.toString();
/** The text under the editor's AI-draft review highlight (never written to the file). */
const reviewed = (path: string) => {
  const state = openNote(path)!.view()!.state;
  return aiDraftRanges(state).map((r) => state.sliceDoc(r.from, r.to));
};

/** 그 노트를 진짜 편집기로 열고 커서를 `caret` 에 둔다. */
async function mountAt(th: TestHost, path: string, caret: number) {
  await th.mount(path);
  openNote(path)!.view()!.dispatch({ selection: { anchor: caret } });
}

beforeEach(() => setLang('en'));
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  closeAllDialogs();
  cleanupDialogs();
  vi.restoreAllMocks();
});

describe('draftMethodCommand (#112)', () => {
  it("fills the unit operation's Method in the note it started from", async () => {
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, IN_METHOD);
    const { env } = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(env);
    // 2026-11-11: no marker line in the file; the editor highlights the draft until it is reviewed.
    expect(IN_FILLED_METHOD(docOf(NOTE))).toBe(true);
    expect(reviewed(NOTE)).toEqual(['1. 원심분리']);
    expect(th.notes).toContainEqual({ kind: 'info', message: 'Inserted the Method draft into 001_WD010_A.labnote.md.' });
    expect(currentDialog()).toBeNull();
  });

  it('writes the draft without moving the cursor and notifies', async () => {
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, IN_METHOD);
    const { env } = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(env);
    // #420: what the user typed on while waiting must not land in the draft, so the cursor stays put.
    expect(openNote(NOTE)!.view()!.state.selection.main.head).toBe(IN_METHOD);
    expect(th.notes).toEqual([{ kind: 'info', message: 'Inserted the Method draft into 001_WD010_A.labnote.md.' }]);
  });

  it("does not overwrite a same-named unit operation's Method in another note", async () => {
    const th = host({ [NOTE]: BODY, [OTHER]: BODY });
    await mountAt(th, OTHER, IN_METHOD);
    await mountAt(th, NOTE, IN_METHOD);
    const { env } = aiEnv(th, () => {
      th.setActive(OTHER); // the user moved to another note while the model wrote
      return reply('1. 원심분리');
    });
    await draftMethodCommand(env);
    expect(docOf(OTHER)).toBe(BODY);
    expect(docOf(NOTE)).toBe(BODY);
    const spec = currentDialog()?.spec as { kind: string; content: string; onInsert: () => Promise<boolean> };
    expect(spec.kind).toBe('aiAnswer');
    expect(spec.content).toBe('1. 원심분리');

    // writes into the Method from the dialog after returning
    th.setActive(NOTE);
    await expect(spec.onInsert()).resolves.toBe(true);
    expect(IN_FILLED_METHOD(docOf(NOTE))).toBe(true);
    expect(reviewed(NOTE)).toEqual(['1. 원심분리']);
    expect(docOf(OTHER)).toBe(BODY);
  });

  it('request bodies are unchanged by the context-window setting (snapshot, both providers)', async () => {
    const bodies: Record<string, unknown> = {};
    for (const provider of ['openai', 'ollama'] as const) {
      const th = host({ [NOTE]: BODY }, { ...LLM, llmProvider: provider, llmContextWindow: 32768 });
      await mountAt(th, NOTE, IN_METHOD);
      const answer = provider === 'openai' ? reply('1. 원심분리') : { status: 200, text: JSON.stringify({ message: { content: '1. 원심분리' } }) };
      const { f } = aiEnv(th, () => answer);
      await draftMethodCommand(createAiEnv(th.ctx, f.invoke));
      const call = f.calls.find(([c]) => c === 'llm_chat');
      const body = JSON.parse(JSON.stringify(call![1].body)) as Record<string, unknown>;
      bodies[provider] = { keys: Object.keys(body).sort(), options: body.options, temperature: body.temperature };
      th.cleanup();
      hosts = hosts.filter((h) => h !== th);
      closeAllDialogs();
    }
    expect(bodies).toEqual({
      // The output cap is the one field every request now carries (Draft Method: the text task's 8192, bounded by the window).
      openai: { keys: ['max_tokens', 'messages', 'model', 'temperature'], options: undefined, temperature: 0.2 },
      ollama: { keys: ['messages', 'model', 'options', 'stream'], options: { temperature: 0.2, num_predict: 8192 }, temperature: undefined },
    });
  });

  // #399
  it('asks nothing when no provider is configured', async () => {
    const th = host({ [NOTE]: BODY }, { llmProvider: 'none' });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('x'));
    await draftMethodCommand(env);
    expect(th.notes).toEqual([{ kind: 'info', message: t('ai.configureFirst') }]);
    expect(th.asked.pick).toEqual([]);
    expect(th.asked.confirm).toEqual([]);
    expect(f.calls.some(([c]) => c === 'llm_chat')).toBe(false);
  });

  it('without an open note it says to open one', async () => {
    const th = host({});
    const { f, env } = aiEnv(th, () => reply('x'));
    await draftMethodCommand(env);
    expect(th.notes).toEqual([{ kind: 'info', message: 'Open a note to insert into.' }]);
    expect(f.calls).toEqual([]);
  });

  // #392
  it('a workflow note without unit operations stops with a notice', async () => {
    const th = host({ [NOTE]: '## [WD010 A]\n\n## 결론\n' });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('x'));
    await draftMethodCommand(env);
    expect(th.notes.map((n) => n.message)).toEqual([
      'This workflow note has no unit operation yet. Insert one first, then draft its Method.',
    ]);
    expect(f.calls.some(([c]) => c === 'llm_chat')).toBe(false);
  });

  // #164
  it('outside a unit operation it picks one, marking those with a Method', async () => {
    const two = BODY.replace('## 결과', '### [UHW020 Wash]\n\n#### Method\n1. 이미 씀\n\n#### Output\n\n## 결과');
    const th = host({ [NOTE]: two });
    await mountAt(th, NOTE, 0);
    th.answer.pick((items) => items[0].value);
    const { f, env } = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(env);
    expect(th.asked.pick).toHaveLength(1);
    const { items, opts } = th.asked.pick[0];
    expect(items.map((i) => i.label)).toEqual(['[UHW010 Spin]', '[UHW020 Wash]']);
    expect(items.map((i) => i.detail)).toEqual([undefined, coreT('Has a Method already')]);
    expect(opts?.placeholder).toBe("Which unit operation's Method should the draft go in?");
    expect(th.asked.confirm).toEqual([]); // the chosen Method was empty
    expect(sent(f)[0][1].content).toContain('Draft the Method body for the unit operation "[UHW010 Spin]".');
    const doc = docOf(NOTE);
    expect(doc).toContain('### [UHW010 Spin]\n\n#### Method\n\n1. 원심분리');
    expect(doc).toContain('1. 이미 씀');
  });

  it('a closed pick stops before the request', async () => {
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('x'));
    await draftMethodCommand(env);
    expect(th.asked.pick).toHaveLength(1);
    expect(f.calls.some(([c]) => c === 'llm_chat')).toBe(false);
    expect(docOf(NOTE)).toBe(BODY);
  });

  it('an existing Method is replaced only after a destructive confirm, asked before the request', async () => {
    const written = BODY.replace('#### Method\n\n', '#### Method\n1. 내가 쓴 방법\n');
    const th = host({ [NOTE]: written });
    await mountAt(th, NOTE, written.indexOf('#### Method') + 2);
    th.answer.confirm(false);
    const first = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(first.env);
    expect(th.asked.confirm).toEqual([
      {
        message: 'This Method section already has content. Replace it with the AI draft?',
        opts: { confirmLabel: 'Replace', destructive: true },
      },
    ]);
    expect(first.order).toEqual(['confirm']); // declined: no request at all
    expect(docOf(NOTE)).toBe(written);

    th.answer.confirm(true);
    const second = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(second.env);
    expect(second.order).toEqual(['confirm', 'llm_chat']);
    const doc = docOf(NOTE);
    expect(doc).not.toContain('내가 쓴 방법');
    expect(IN_FILLED_METHOD(doc)).toBe(true);
  });

  it('puts the draft in as a plain block in a note without a Method, and says when it went to the end', async () => {
    const FREE = 'notes/free.md';
    const th = host({ [FREE]: '# Free\n\nabc\n' });
    await mountAt(th, FREE, 0);
    const { env } = aiEnv(th, () => reply('1. 원심분리\n\n2. 세척'));
    await draftMethodCommand(env);
    expect(docOf(FREE)).toBe('# Free\n\nabc\n\n1. 원심분리\n\n2. 세척\n');
    expect(reviewed(FREE)).toEqual(['1. 원심분리\n\n2. 세척']);
    const messages = th.notes.map((n) => n.message);
    expect(messages).toContain('The cursor was above the note body, so the draft went to the end of the note.');
    expect(messages).toContain('Inserted the Method draft into free.md.');
    expect(openNote(FREE)!.view()!.state.selection.main.head).toBe(0); // not revealed (#420)
  });

  it('sends the exact system prompt and the 6000-char cap', async () => {
    const FREE = 'notes/long.md';
    const text = `# Long\n\n${'가'.repeat(7000)}\n`;
    const th = host({ [FREE]: text });
    await mountAt(th, FREE, 0);
    const { f, env } = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(env);
    const [messages] = sent(f);
    expect(messages).toEqual([
      {
        role: 'system',
        content:
          'You write concise, reproducible **Method** subsections for a scientific lab notebook. Output only the Method body as GitHub-flavored Markdown: no front matter, no headings, no preamble or code fences. ' +
          'Write the answer in English. Keep sample IDs, units, numbers and quoted text exactly as they appear in the note.',
      },
      { role: 'user', content: ['Draft a Method subsection for this note.', '', 'Context:', text.slice(0, 6000)].join('\n') },
    ]);
  });

  it('sends the unit-operation system prompt with the 2000 head and 4000 block caps', async () => {
    const head = `---\ntitle: x\n---\n## [WD010 A]\n${'h'.repeat(2500)}\n`;
    const block = `### [UHW010 Spin]\n\n#### Method\n\n\n#### Reagent\n${'b'.repeat(4500)}\n`;
    const text = `${head}${block}`;
    const th = host({ [NOTE]: text });
    await mountAt(th, NOTE, text.indexOf('#### Method') + 2);
    const { f, env } = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(env);
    const [[system, user]] = sent(f);
    expect(system.content).toBe(
      'You write the body of the **Method** subsection of one unit operation in a scientific lab notebook: concise, reproducible steps. Output only that body as GitHub-flavored Markdown (for example a numbered list) — no headings, no other subsections, no preamble or code fences. ' +
        'Write the answer in English. Keep sample IDs, units, numbers and quoted text exactly as they appear in the note.',
    );
    const lines = user.content.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'Draft the Method body for the unit operation "[UHW010 Spin]".',
      '',
      'Note front matter and workflow description:',
    ]);
    // joined so the escapes guard does not read a letter, a colon and a backslash as a drive path
    const marker = ['', '', 'Unit operation:', ''].join('\n');
    const at = user.content.indexOf(marker);
    const headPart = user.content.slice(user.content.indexOf('description:') + 'description:'.length + 1, at);
    expect(headPart.length).toBe(2000);
    expect(user.content.slice(at + marker.length).length).toBe(4000);
  });

  it('asks for Korean in a Korean UI and, with the setting on, writes the header in Korean', async () => {
    setLang('ko');
    const th = host({ [NOTE]: BODY }, { ...LLM, aiDraftNoteInFile: true });
    await mountAt(th, NOTE, IN_METHOD);
    const { f, env } = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(env);
    const [[system]] = sent(f);
    expect(system.content).toContain('Write the answer in Korean.');
    expect(system.content).toContain('Keep sample IDs');
    const header = coreT('AI draft ({0}, {1}) — review it, then delete this line', 'llama3.1', getSeoulDateString());
    expect(header).not.toContain('review it');
    expect(docOf(NOTE)).toContain(`> [!note] ${header}`);
  });

  // #195
  it('an empty reply says the model gave no answer and leaves the note alone', async () => {
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, IN_METHOD);
    const { env } = aiEnv(th, () => reply('  '));
    await draftMethodCommand(env);
    expect(th.notes).toEqual([{ kind: 'warn', message: 'The model gave no answer. Try again or choose another model.' }]);
    expect(docOf(NOTE)).toBe(BODY);
    expect(currentDialog()).toBeNull();
  });

  it('neutralizes issue markers in the draft', async () => {
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, IN_METHOD);
    const { env } = aiEnv(th, () => reply('1. Spin @issue;rotor'));
    await draftMethodCommand(env);
    expect(docOf(NOTE)).toContain('1. Spin');
    expect(docOf(NOTE)).not.toContain('@issue;');
  });
});

describe('draftMethodCommand with "Keep an AI-draft note in the file" on', () => {
  const KEEP = { ...LLM, aiDraftNoteInFile: true };

  it('writes the old marker line over the Method draft (#280)', async () => {
    const th = host({ [NOTE]: BODY }, KEEP);
    await mountAt(th, NOTE, IN_METHOD);
    const { env } = aiEnv(th, () => reply('1. 원심분리'));
    await draftMethodCommand(env);
    expect(IN_MARKED_METHOD(docOf(NOTE))).toBe(true);
  });

  it('keeps the whole draft inside the AI callout in a note without a Method (#392)', async () => {
    const FREE = 'notes/free.md';
    const th = host({ [FREE]: '# Free\n\nabc\n' }, KEEP);
    await mountAt(th, FREE, 0);
    const { env } = aiEnv(th, () => reply('1. 원심분리\n\n2. 세척'));
    await draftMethodCommand(env);
    expect(docOf(FREE)).toMatch(
      /^# Free\n\nabc\n\n> \[!note\] AI draft \(llama3\.1, [\d-]+\) — review it, then delete this line\n> 1\. 원심분리\n>\n> 2\. 세척\n$/,
    );
  });
});

describe('toNoteCallout', () => {
  it('quotes every line under the header, blank lines as a bare >', () => {
    expect(toNoteCallout('  a\n\nb  \n', 'H')).toBe('> [!note] H\n> a\n>\n> b');
  });
});
