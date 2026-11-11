// @vitest-environment jsdom
/**
 * "AI: 결과 요약" / "AI: 실험 결과 요약"(Task 33). vendor tests/plugin/aiInsertTarget.test.ts 의 요약 사례
 * (#112, #260, #279, #306, #195, 답 언어)를 옮겼다: 제공자 흉내는 `fakeInvoke({ llm_chat })`, 편집 대상은 진짜 편집기다.
 */
import { extractResultSections } from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { entryEvents } from '../../labnote/commands/entryEvents';
import { closeAllDialogs, currentDialog } from '../../labnote/host/dialogStore';
import { cleanupDialogs } from '../../labnote/host/__tests__/harness';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { openNote } from '../../labnote/openNotes';
import {
  isExperimentReadme,
  summarizeExperimentCommand,
  summarizeResultsCommand,
  toNoteCallout,
} from '../../labnote/port/aiSummaries';
import { createAiEnv } from '../aiEnv';

const DIR = 'labnote/001_Test';
const NOTE = `${DIR}/001_WD010_A.labnote.md`;
const OTHER = `${DIR}/002_WB030_B.labnote.md`;
const RENAMED = `${DIR}/001_WD010_A_fixed.labnote.md`;
const README = `${DIR}/README.labnote.md`;
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
const LLM = { llmProvider: 'openai', llmEndpointOpenai: 'https://llm.example.test', llmModel: 'llama3.1' } as const;
/** The user message's lead-ins, joined so the escapes guard does not read "s:" plus an escape as a drive path. */
const SUMMARIZE = ['Summarize these results:', '', ''].join('\n');
const EACH_WORKFLOW = ['Results of each workflow:', '', ''].join('\n');
const NO_RESULTS =
  'No results to summarize yet. Write them under a unit operation\'s "Results & Discussions", "QC Metrics" or "Discussion", a software unit operation\'s "Output", or "Conclusions and Discussion", and run this again.';

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
const chats = (f: ReturnType<typeof fakeInvoke>) => f.calls.filter(([c]) => c === 'llm_chat').length;

const docOf = (path: string) => openNote(path)!.view()!.state.doc.toString();

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

describe('summarizeResultsCommand (#112)', () => {
  it('inserts into the note it started from while that note is open', async () => {
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, BODY.indexOf('결과 문단'));
    const { env } = aiEnv(th, () => reply('- 요약'));
    await summarizeResultsCommand(env);
    expect(docOf(NOTE)).toMatch(/> \[!note\] AI workflow results summary \(llama3\.1, \d{4}-\d{2}-\d{2}\)\n> - 요약\n$/);
    expect(currentDialog()).toBeNull();
    expect(th.notes).toContainEqual({ kind: 'info', message: 'Inserted the summary into 001_WD010_A.labnote.md.' });
    // #319: no Conclusions heading in this note, so it says where the summary went.
    expect(th.notes).toContainEqual({
      kind: 'info',
      message: 'There is no "Conclusions and Discussion" section, so the summary went at the end of the note.',
    });
  });

  it('leaves another note alone and opens the dialog instead', async () => {
    const th = host({ [NOTE]: BODY, [OTHER]: BODY });
    await mountAt(th, OTHER, 0);
    await mountAt(th, NOTE, BODY.indexOf('결과 문단'));
    const { env } = aiEnv(th, () => {
      th.setActive(OTHER); // the user moved to another note while the model wrote
      return reply('- 요약');
    });
    await summarizeResultsCommand(env);
    expect(docOf(OTHER)).toBe(BODY);
    expect(docOf(NOTE)).toBe(BODY);
    const spec = currentDialog()?.spec as { kind: string; content: string; onInsert: () => Promise<boolean> };
    expect(spec.kind).toBe('aiAnswer');
    // #150: the summary is a callout naming the model and the date.
    expect(spec.content).toMatch(/^> \[!note\] AI workflow results summary \(llama3\.1, \d{4}-\d{2}-\d{2}\)\n> - 요약$/);
    await expect(spec.onInsert()).resolves.toBe(false);
    expect(docOf(OTHER)).toBe(BODY);
    expect(th.notes.at(-1)?.message).toBe('That note is no longer open. Copy the answer instead.');
  });

  it('inserts from the dialog once the user is back in that note', async () => {
    const th = host({ [NOTE]: BODY, [OTHER]: BODY });
    await mountAt(th, OTHER, 0);
    await mountAt(th, NOTE, BODY.indexOf('결과 문단'));
    const { env } = aiEnv(th, () => {
      th.setActive(OTHER);
      return reply('- 요약');
    });
    await summarizeResultsCommand(env);
    const spec = currentDialog()?.spec as { onInsert: () => Promise<boolean> };
    th.setActive(NOTE);
    await expect(spec.onInsert()).resolves.toBe(true);
    expect(docOf(NOTE)).toContain('> - 요약');
    expect(docOf(OTHER)).toBe(BODY);
  });

  // #260: renaming the note while the model writes is still the same note.
  it('inserts into the note it started from after it was renamed', async () => {
    const th = host({ [NOTE]: BODY, [RENAMED]: BODY });
    await mountAt(th, RENAMED, 0);
    await mountAt(th, NOTE, BODY.indexOf('결과 문단'));
    const { env } = aiEnv(th, () => {
      entryEvents.emit({
        kind: 'renamed',
        from: NOTE,
        to: RENAMED,
        isDir: false,
        files: [{ from: NOTE, to: RENAMED }],
        settled: Promise.resolve(),
      });
      th.setActive(RENAMED);
      return reply('- 요약');
    });
    await summarizeResultsCommand(env);
    expect(currentDialog()).toBeNull();
    expect(docOf(RENAMED)).toContain('> - 요약');
    expect(th.notes).toContainEqual({ kind: 'info', message: 'Inserted the summary into 001_WD010_A_fixed.labnote.md.' });
  });

  // #257: a note holding only the template got invented measurements back.
  it('needs recorded results', async () => {
    const empty = BODY.replace('## 결과\n\n결과 문단\n', '');
    const th = host({ [NOTE]: empty });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('- 요약'));
    await summarizeResultsCommand(env);
    expect(chats(f)).toBe(0);
    expect(th.notes).toEqual([{ kind: 'info', message: NO_RESULTS }]);
    expect(docOf(NOTE)).toBe(empty);
  });

  it('says there is nothing to summarize in an empty note', async () => {
    const th = host({ 'notes/empty.md': '  \n' });
    await mountAt(th, 'notes/empty.md', 0);
    const { f, env } = aiEnv(th, () => reply('- 요약'));
    await summarizeResultsCommand(env);
    expect(chats(f)).toBe(0);
    expect(th.notes).toEqual([{ kind: 'info', message: 'Nothing to summarize.' }]);
  });

  it('without an open note it says to open one', async () => {
    const th = host({});
    const { f, env } = aiEnv(th, () => reply('x'));
    await summarizeResultsCommand(env);
    expect(th.notes).toEqual([{ kind: 'info', message: 'Open a note to insert into.' }]);
    expect(f.calls).toEqual([]);
  });

  it('sends the note without the template wording, and tells the model not to invent results', async () => {
    const text = BODY.replace('#### Output\n', '#### Output\n- (samples to the next step)\n');
    const th = host({ [NOTE]: text });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('- 요약'));
    await summarizeResultsCommand(env);
    const [[system, user]] = sent(f);
    expect(system.content).toContain('never invent a number');
    expect(user.content).not.toContain('(samples to the next step)');
    expect(user.content).toContain('결과 문단');
  });

  it('refuses on a README', async () => {
    const th = host({ [README]: '## Summary and Discussion\n\n메모\n' });
    await mountAt(th, README, 0);
    const { f, env } = aiEnv(th, () => reply('- 요약'));
    await summarizeResultsCommand(env);
    expect(chats(f)).toBe(0);
    expect(th.notes).toEqual([{ kind: 'info', message: 'In an experiment README, run "AI: Summarize experiment results".' }]);
  });

  it('without a provider it says to configure one and sends nothing', async () => {
    const th = host({ [NOTE]: BODY }, { llmProvider: 'none' });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('x'));
    await summarizeResultsCommand(env);
    expect(th.notes).toEqual([{ kind: 'info', message: t('ai.configureFirst') }]);
    expect(chats(f)).toBe(0);
    expect(docOf(NOTE)).toBe(BODY);
  });

  // #195
  it('an empty reply says the model gave no answer and leaves the note alone', async () => {
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, 0);
    const { env } = aiEnv(th, () => reply('  '));
    await summarizeResultsCommand(env);
    expect(th.notes).toEqual([{ kind: 'warn', message: 'The model gave no answer. Try again or choose another model.' }]);
    expect(docOf(NOTE)).toBe(BODY);
    expect(currentDialog()).toBeNull();
  });

  it('other notes: strips front matter, AI callouts, placeholders and issue markers, inserts after the cursor line', async () => {
    const FREE = 'notes/free.md';
    const text = [
      '---',
      'title: 비밀 제목',
      '---',
      '# Free',
      '',
      '측정값 12 mg @issue;i1;원심 이상',
      '- (Any results and discussions. Link file path if needed)',
      '',
      '> [!note] AI summary (old, 2026-01-01)',
      '> - 옛 요약',
      '',
      '끝 줄',
      '',
    ].join('\n');
    const th = host({ [FREE]: text });
    const caret = text.indexOf('측정값') + 2;
    await mountAt(th, FREE, caret);
    const { f, env } = aiEnv(th, () => reply('- 12 mg 측정 @issue;x;y'));
    await summarizeResultsCommand(env);
    const [[, user]] = sent(f);
    expect(user.content.startsWith(SUMMARIZE)).toBe(true);
    expect(user.content).toContain('측정값 12 mg');
    expect(user.content).toContain('원심 이상');
    for (const gone of ['비밀 제목', '@issue', '(Any results and discussions', '옛 요약']) expect(user.content).not.toContain(gone);
    const doc = docOf(FREE);
    // after the cursor's line, not at the end; the cursor stays put (#420)
    expect(doc).toMatch(/측정값 12 mg @issue;i1;원심 이상\n\n> \[!note\] AI summary \(llama3\.1, [\d-]+\)\n> - 12 mg 측정 issue;x;y\n/);
    expect(openNote(FREE)!.view()!.state.selection.main.head).toBe(caret);
    expect(th.notes).toEqual([{ kind: 'info', message: 'Inserted the summary into free.md.' }]);
  });
});

// #279: the summary went after the cursor line, and the model got the whole note.
describe('summarizeResultsCommand in a workflow note (#279)', () => {
  const NOTE_BODY = [
    '---',
    'title: WD010 A',
    '---',
    '## [WD010 A]',
    '',
    '### [UHW010 Spin] 조건 A',
    '',
    '#### Reagent',
    '- Tris 50 mM',
    '',
    '#### Results & Discussions',
    '수율 82%',
    '',
    '## Conclusions and Discussion',
    '',
    '내 결론 메모',
    '',
    '',
  ].join('\n');
  const EARLIER = NOTE_BODY.replace(
    '내 결론 메모\n',
    '내 결론 메모\n\n> [!note] AI workflow results summary (old, 2026-01-01)\n> - 옛 요약\n',
  );

  it('workflow note: sends extractResultSections and appends to Conclusions and Discussion', async () => {
    const th = host({ [NOTE]: NOTE_BODY });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('- 수율 82%'));
    await summarizeResultsCommand(env);
    const [[system, user]] = sent(f);
    expect(user.content).toBe(`${SUMMARIZE}${extractResultSections(NOTE_BODY)}`);
    expect(user.content).toContain('[UHW010 Spin] 조건 A › Results & Discussions\n수율 82%');
    expect(user.content).not.toContain('Tris');
    expect(user.content).not.toContain('title: WD010 A');
    expect(system.content).toBe(
      'You summarize experimental Results for a lab notebook as 3–6 concise Markdown bullet points. No preamble, no code fences. ' +
        'Use only measurements and observations written in the note; never invent a number, a result or a conclusion that is not there. ' +
        'Name a sample by its alias or ID in plain words; never copy a sample reference written as "ID;alias" or "@Type;ID;alias", and never write "@issue". ' +
        'Write the answer in English. Keep units, numbers and quoted text exactly as they appear in the note.',
    );
    expect(docOf(NOTE)).toMatch(/내 결론 메모\n\n> \[!note\] AI workflow results summary \(llama3\.1, [\d-]+\)\n> - 수율 82%\n/);
    expect(th.asked.confirm).toEqual([]); // nothing to replace
    expect(th.notes).toEqual([{ kind: 'info', message: 'Inserted the summary into 001_WD010_A.labnote.md.' }]);
  });

  it('caps the results at 6000 characters', async () => {
    const long = NOTE_BODY.replace('수율 82%', `수율 ${'9'.repeat(7000)}`);
    const th = host({ [NOTE]: long });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('- 수율'));
    await summarizeResultsCommand(env);
    const [[, user]] = sent(f);
    expect(user.content).toBe(`${SUMMARIZE}${extractResultSections(long).slice(0, 6000)}`);
  });

  it('a second run replaces the earlier AI callout after a destructive confirm', async () => {
    const th = host({ [NOTE]: EARLIER });
    await mountAt(th, NOTE, 0);
    th.answer.confirm(true);
    const { order, env } = aiEnv(th, () => reply('- 새 요약'));
    await summarizeResultsCommand(env);
    expect(order).toEqual(['confirm', 'llm_chat']); // asked before the request
    expect(th.asked.confirm).toEqual([
      {
        message:
          '"Conclusions and Discussion" already has an AI summary. Replace it with a new one? ' +
          'What you typed inside the callout is replaced too; keep notes you want outside it.',
        opts: { confirmLabel: 'Replace', destructive: true },
      },
    ]);
    const doc = docOf(NOTE);
    expect(doc).not.toContain('옛 요약');
    expect(doc.match(/AI workflow results summary/g)).toHaveLength(1);
    expect(doc).toContain('내 결론 메모\n\n> [!note] AI workflow results summary (llama3.1');
    expect(doc).toContain('> - 새 요약');
  });

  it('a declined replace sends nothing and leaves the note alone', async () => {
    const th = host({ [NOTE]: EARLIER });
    await mountAt(th, NOTE, 0);
    th.answer.confirm(false);
    const { order, env } = aiEnv(th, () => reply('- 새 요약'));
    await summarizeResultsCommand(env);
    expect(order).toEqual(['confirm']);
    expect(docOf(NOTE)).toBe(EARLIER);
    expect(th.notes).toEqual([]);
  });
});

// #306: there was no way to summarize a whole experiment.
describe('summarizeExperimentCommand (#306)', () => {
  const README_BODY = [
    '---',
    'title: Test',
    '---',
    '## 🗂️ Related Workflows',
    '- [ ] [B](./002_WB030_B.labnote.md)',
    '- [ ] [A](./001_WD010_A.labnote.md)',
    '',
    '## Summary and Discussion',
    '',
    '연구원 메모',
    '',
  ].join('\n');
  const notes: Record<string, string> = {
    [NOTE]: '## [WD010 A]\n\n### [UHW010 Spin]\n\n#### Results & Discussions\nA 결과\n',
    [OTHER]: '## [WB030 B]\n\n### [UHW020 Mix]\n\n#### Results & Discussions\nB 결과\n',
  };

  it('sends the results of each workflow in checklist order with the README notes, into Summary and Discussion', async () => {
    const th = host({ [README]: README_BODY, ...notes, [`${DIR}/notes.txt`]: 'x' });
    await mountAt(th, README, 0);
    const { f, env } = aiEnv(th, () => reply('- 전체 요약'));
    await summarizeExperimentCommand(env);
    const [[system, user]] = sent(f);
    expect(system.content).toContain('inside <researcher-notes>, are context only');
    expect(system.content).toContain('Write the answer in English. Keep units, numbers and quoted text');
    expect(user.content.startsWith(`<researcher-notes>\n연구원 메모\n</researcher-notes>\n\n${EACH_WORKFLOW}`)).toBe(true);
    expect(user.content.indexOf('B 결과')).toBeLessThan(user.content.indexOf('A 결과'));
    expect(docOf(README)).toMatch(/연구원 메모\n\n> \[!note\] AI experiment results summary \(llama3\.1, [\d-]+\)\n> - 전체 요약\n$/);
    expect(th.notes).toContainEqual({ kind: 'info', message: 'Summarized the results of 2 workflow note(s) into README.labnote.md.' });
  });

  it('stops without asking the model while no workflow note has results', async () => {
    const th = host({
      [README]: README_BODY,
      [NOTE]: '## [WD010 A]\n\n### [UHW010 Spin]\n\n#### Results & Discussions\n- (Any results and discussions. Link file path if needed)\n',
    });
    await mountAt(th, README, 0);
    const { f, env } = aiEnv(th, () => reply('- 전체 요약'));
    await summarizeExperimentCommand(env);
    expect(chats(f)).toBe(0);
    expect(th.notes).toEqual([
      { kind: 'info', message: 'No results are written in the workflow notes of this experiment yet, so there is nothing to summarize.' },
    ]);
  });

  it('outside a README it says to open one', async () => {
    const th = host({ ...notes });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('x'));
    await summarizeExperimentCommand(env);
    expect(chats(f)).toBe(0);
    expect(th.notes).toEqual([{ kind: 'info', message: 'Open an experiment README first.' }]);
  });

  it('experiment: reads each workflow note (open editor text first), shares the 10000 budget, adds the 2000-char memo', async () => {
    const big = (head: string, ch: string) => `## [${head}]\n\n### [UHW010 Spin]\n\n#### Results & Discussions\n${ch.repeat(8000)}\n`;
    const readme = README_BODY.replace('연구원 메모', 'm'.repeat(3000));
    const th = host({ [README]: readme, [NOTE]: big('WD010 A', 'a'), [OTHER]: big('WB030 B', 'b') });
    // OTHER is open and its unsaved buffer differs from the disk
    await mountAt(th, OTHER, 0);
    const view = openNote(OTHER)!.view()!;
    const edited = big('WB030 B', 'c');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: edited } });
    await mountAt(th, README, 0);
    const { f, env } = aiEnv(th, () => reply('- 전체 요약'));
    await summarizeExperimentCommand(env);
    const [[, user]] = sent(f);
    expect(user.content).toContain(`<researcher-notes>\n${'m'.repeat(2000)}\n</researcher-notes>`);
    expect(user.content).not.toContain('m'.repeat(2001));
    expect(user.content).not.toContain('bbbb'); // the editor's text, not the file's
    const a = extractResultSections(big('WD010 A', 'a'));
    const c = extractResultSections(edited);
    // each gets half of 10000 (both are longer)
    expect(user.content).toContain(`\n${c.slice(0, 5000)}\n\n## `);
    expect(user.content.endsWith(`\n${a.slice(0, 5000)}`)).toBe(true);
  });

  it('drops memo lines the model echoed back', async () => {
    const memoLine = '수율이 낮은 이유는 반응 온도가 너무 높았기 때문으로 보인다';
    const readme = README_BODY.replace('연구원 메모', memoLine);
    const th = host({ [README]: readme, ...notes });
    await mountAt(th, README, 0);
    const { env } = aiEnv(th, () => reply(`- ${memoLine}\n- B 단계에서 순도 95%를 얻었다`));
    await summarizeExperimentCommand(env);
    const doc = docOf(README);
    const callout = doc.slice(doc.indexOf('> [!note] AI experiment results summary'));
    expect(callout).toContain('> - B 단계에서 순도 95%를 얻었다');
    expect(callout).not.toContain(memoLine);
    expect(doc).toContain(`${memoLine}\n\n> [!note]`); // the researcher's own line stays
  });

  it('a second run replaces the earlier experiment summary after a destructive confirm', async () => {
    const readme = README_BODY.replace('연구원 메모\n', '연구원 메모\n\n> [!note] AI experiment results summary (old, 2026-01-01)\n> - 옛 요약\n');
    const th = host({ [README]: readme, ...notes });
    await mountAt(th, README, 0);
    th.answer.confirm(true);
    const { order, env } = aiEnv(th, () => reply('- 새 요약'));
    await summarizeExperimentCommand(env);
    expect(order).toEqual(['confirm', 'llm_chat']);
    expect(th.asked.confirm[0].message).toContain('"Summary and Discussion" already has an AI summary.');
    const doc = docOf(README);
    expect(doc).not.toContain('옛 요약');
    expect(doc.match(/AI experiment results summary/g)).toHaveLength(1);
  });
});

describe('reply language', () => {
  it('asks for Korean in a Korean UI, leaves "keep sample IDs" out and writes the header in Korean', async () => {
    setLang('ko');
    const th = host({ [NOTE]: BODY });
    await mountAt(th, NOTE, 0);
    const { f, env } = aiEnv(th, () => reply('- 요약'));
    await summarizeResultsCommand(env);
    const [[system]] = sent(f);
    expect(system.content).toContain('Write the answer in Korean.');
    // #527: the summary is not told to keep sample IDs as written.
    expect(system.content).not.toContain('Keep sample IDs');
    expect(system.content).toContain('Keep units, numbers and quoted text');
    const header = coreT('AI workflow results summary ({0}, {1})', 'llama3.1', getSeoulDateString());
    expect(header).not.toContain('AI workflow results summary');
    expect(docOf(NOTE)).toContain(`> [!note] ${header}`);
  });

  it('a Korean UI still finds the earlier English summary to replace', async () => {
    setLang('ko');
    const body =
      '## [WD010 A]\n\n### [UHW010 Spin]\n\n#### Results & Discussions\n수율 82%\n\n## Conclusions and Discussion\n\n> [!note] AI workflow results summary (old, 2026-01-01)\n> - 옛 요약\n';
    const th = host({ [NOTE]: body });
    await mountAt(th, NOTE, 0);
    th.answer.confirm(true);
    const { env } = aiEnv(th, () => reply('- 새 요약'));
    await summarizeResultsCommand(env);
    expect(th.asked.confirm).toHaveLength(1);
    expect(docOf(NOTE)).not.toContain('옛 요약');
  });

  it('writes the Korean header with Workflow in English and still replaces a plugin-written 워크플로 summary', async () => {
    setLang('ko');
    const body =
      '## [WD010 A]\n\n### [UHW010 Spin]\n\n#### Results & Discussions\n수율 82%\n\n## Conclusions and Discussion\n\n> [!note] AI 워크플로 결과 요약 (old, 2026-01-01)\n> - 옛 요약\n';
    const th = host({ [NOTE]: body });
    await mountAt(th, NOTE, 0);
    th.answer.confirm(true);
    const { env } = aiEnv(th, () => reply('- 새 요약'));
    await summarizeResultsCommand(env);
    expect(th.asked.confirm).toHaveLength(1);
    const doc = docOf(NOTE);
    expect(doc).not.toContain('옛 요약');
    expect(doc).not.toContain('워크플로');
    expect(doc).toContain('> [!note] AI Workflow 결과 요약 (llama3.1');
  });
});

describe('helpers', () => {
  it('isExperimentReadme', () => {
    expect(isExperimentReadme(README)).toBe(true);
    expect(isExperimentReadme(NOTE)).toBe(false);
    expect(isExperimentReadme('notes/README.md')).toBe(false);
  });

  it('toNoteCallout is the shared one', () => {
    expect(toNoteCallout('a\n\nb', 'H')).toBe('> [!note] H\n> a\n>\n> b');
  });
});
