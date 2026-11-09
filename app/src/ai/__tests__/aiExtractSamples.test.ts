// @vitest-environment jsdom
/**
 * "AI: 샘플 정의 추출"(Task 34). vendor tests/plugin/parseJsonArray.test.ts, prepareExtractedSamples.test.ts 의 모든 사례와
 * aiInsertTarget.test.ts 의 추출 사례를 옮겼다: 제공자 흉내는 `fakeInvoke({ llm_chat })`, 대장은 가짜 보관함의 진짜 파일이다.
 */
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import { cancelAllRequests } from '../../integrations/netIpc';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { cleanupDialogs } from '../../labnote/host/__tests__/harness';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import {
  extractSamplesCommand,
  parseJsonArray,
  prepareExtractedSamples,
  skipKnownSamples,
} from '../../labnote/port/aiExtractSamples';
import { sampleEvents } from '../../samples/env';
import { createAiEnv } from '../aiEnv';

describe('parseJsonArray', () => {
  it('parses a bare JSON array', () => {
    expect(parseJsonArray('[{"type":"DNA","id":"DNA-1"}]')).toEqual([{ type: 'DNA', id: 'DNA-1' }]);
  });

  it('parses an empty array', () => {
    expect(parseJsonArray('[]')).toEqual([]);
  });

  it('strips a ```json fence', () => {
    expect(parseJsonArray('```json\n[{"type":"RNA"}]\n```')).toEqual([{ type: 'RNA' }]);
  });

  it('strips a bare ``` fence', () => {
    expect(parseJsonArray('```\n[{"type":"RNA"}]\n```')).toEqual([{ type: 'RNA' }]);
  });

  it('finds the array inside surrounding prose', () => {
    // Joined so the escapes guard does not read "found:" plus an escape as a drive path.
    const raw = ['Sure! Here are the samples I found:', '[{"type":"Plasmid","id":"P-1"}]', 'Let me know.'].join('\n');
    expect(parseJsonArray(raw)).toEqual([{ type: 'Plasmid', id: 'P-1' }]);
  });

  it('keeps every field the extractor cares about', () => {
    expect(parseJsonArray('[{"type":"DNA","id":"DNA-1","alias":"pUC19","description":"a plasmid"}]')).toEqual([
      { type: 'DNA', id: 'DNA-1', alias: 'pUC19', description: 'a plasmid' },
    ]);
  });

  it('handles nested objects without truncating at the first bracket', () => {
    const raw = '[{"type":"DNA","description":"contains [brackets] inside"}]';
    expect(parseJsonArray(raw)).toEqual([{ type: 'DNA', description: 'contains [brackets] inside' }]);
  });

  it('returns empty for prose with no array at all', () => {
    expect(parseJsonArray('I could not find any samples in this note.')).toEqual([]);
  });

  it('returns empty for malformed JSON rather than throwing', () => {
    expect(parseJsonArray('[{"type":"DNA",]')).toEqual([]);
    expect(parseJsonArray('[{"type": "DNA"')).toEqual([]);
  });

  it('returns empty for a JSON object that is not an array', () => {
    expect(parseJsonArray('{"type":"DNA"}')).toEqual([]);
  });

  it('returns empty for an empty or whitespace reply', () => {
    expect(parseJsonArray('')).toEqual([]);
    expect(parseJsonArray('   \n  ')).toEqual([]);
  });

  it('parses a JSON array out of fenced or chatty replies', () => {
    const raw = ['```json', 'Here you go:', '[{"type":"DNA","alias":"a"},{"type":"Plasmid"}]', 'Done.', '```'].join('\n');
    expect(parseJsonArray(raw)).toEqual([{ type: 'DNA', alias: 'a' }, { type: 'Plasmid' }]);
  });
});

const TYPES = ['DNA', 'Plasmid', 'Equip', '배지'];

describe('prepareExtractedSamples', () => {
  it('keeps valid ids, spelling type and prefix like the known type', () => {
    expect(prepareExtractedSamples([{ type: 'equip', id: 'equip-3', alias: 'NanoDrop' }], TYPES)).toEqual({
      samples: [{ type: 'Equip', id: 'Equip-3', alias: 'NanoDrop', description: undefined }],
      regenerated: 0,
      unknownType: 0,
    });
  });

  it('drops an id that breaks <Type>-<number>, keeping it as the alias when there is none', () => {
    const out = prepareExtractedSamples(
      [
        { type: 'Equip', id: 'ND-11', description: 'spectrophotometer' },
        { type: 'Plasmid', id: 'pUC19', alias: 'cloning vector' },
      ],
      TYPES
    );
    expect(out.samples).toEqual([
      { type: 'Equip', alias: 'ND-11', description: 'spectrophotometer' },
      { type: 'Plasmid', alias: 'cloning vector', description: undefined },
    ]);
    expect(out.regenerated).toBe(2);
  });

  it('replaces the characters that would split a sample in a note (#98)', () => {
    const out = prepareExtractedSamples(
      [
        { type: 'DNA', id: 'DNA-1', alias: 'EXT-01;여름', description: '여름 추출; 2차' },
        { type: 'DNA', id: 'ratio:1', description: '희석 1:10' },
      ],
      TYPES
    );
    // #390: what the note wrote is kept to say what changed.
    expect(out.samples).toEqual([
      { type: 'DNA', id: 'DNA-1', alias: 'EXT-01-여름', description: '여름 추출, 2차', originalAlias: 'EXT-01;여름' },
      { type: 'DNA', alias: 'ratio-1', description: '희석 1:10', originalAlias: 'ratio:1' },
    ]);
  });

  it('drops the Markdown characters create_sample refuses (#168)', () => {
    const out = prepareExtractedSamples(
      [
        { type: 'DNA', id: 'DNA-1', alias: '#1 [[pUC19]] *v2* `x`' },
        { type: 'DNA', id: 'DNA-2', alias: '###' },
      ],
      TYPES
    );
    expect(out.samples.map(s => s.alias)).toEqual(['1 pUC19 v2 x', undefined]);
  });

  it('turns _ into -, as create_sample refuses it (#225)', () => {
    const out = prepareExtractedSamples([{ type: 'DNA', id: 'DNA-1', alias: '대장균_형질전환' }], TYPES);
    expect(out.samples[0].alias).toBe('대장균-형질전환');
    expect(out.samples[0].originalAlias).toBe('대장균_형질전환');
  });

  it('skips unknown types and accepts custom ones', () => {
    const out = prepareExtractedSamples([{ type: 'Gizmo' }, { type: '배지', id: '배지-1' }], TYPES);
    expect(out.samples).toEqual([{ type: '배지', id: '배지-1', alias: undefined, description: undefined }]);
    expect(out.unknownType).toBe(1);
  });

  // #190: the storage location the note gave was dropped.
  it('keeps the storage location the model found', () => {
    expect(
      prepareExtractedSamples(
        [
          { type: 'DNA', alias: 'GLC-40', location: ' 시약장 2번 선반 ' },
          { type: 'DNA', alias: 'x', location: '  ' },
        ],
        TYPES
      ).samples
    ).toEqual([
      { type: 'DNA', alias: 'GLC-40', location: '시약장 2번 선반' },
      { type: 'DNA', alias: 'x' },
    ]);
  });

  it('leaves the id out when the model gave none', () => {
    expect(prepareExtractedSamples([{ type: 'DNA', alias: 'insert' }], TYPES).samples).toEqual([
      { type: 'DNA', id: undefined, alias: 'insert', description: undefined },
    ]);
  });
});

// #153: running the command again re-created every sample.
describe('skipKnownSamples', () => {
  const rec = (alias: string | null) => ({ type: 'DNA', alias, descriptions: [], sources: [], location: null });

  it('skips registered ids, same-type aliases and ids the note references', () => {
    const out = skipKnownSamples(
      [
        { type: 'DNA', id: 'DNA-1' },
        { type: 'DNA', alias: 'PUC19' },
        { type: 'Plasmid', alias: 'pUC19' },
        { type: 'DNA', id: 'DNA-9' },
        { type: 'DNA', id: 'DNA-7', alias: 'new' },
      ],
      [{ DNA: { 'DNA-1': rec(null) } }, { DNA: { 'DNA-2': rec('pUC19') } }],
      new Set(['dna|dna-9'])
    );
    expect(out.skipped).toBe(3);
    expect(out.fresh).toEqual([
      { type: 'Plasmid', alias: 'pUC19' },
      { type: 'DNA', id: 'DNA-7', alias: 'new' },
    ]);
  });

  it('compares registry aliases the way extracted ones are fitted', () => {
    const out = skipKnownSamples([{ type: 'DNA', alias: 'EXT-01-여름' }], [{ DNA: { 'DNA-2': rec('EXT-01;여름') } }], new Set());
    expect(out.skipped).toBe(1);
  });

  // #153: samples without an alias were created again on every run.
  it('takes the same type and description as the same sample only when neither has an alias', () => {
    const noAlias = { type: 'DNA', alias: null, descriptions: ['정제 카트리지  키트 RX-96'], sources: [], location: null };
    const out = skipKnownSamples(
      [
        { type: 'DNA', description: '정제 카트리지 키트 rx-96' },
        { type: 'DNA', alias: 'kit', description: '정제 카트리지 키트 RX-96' },
        { type: 'Plasmid', description: '정제 카트리지 키트 RX-96' },
        { type: 'DNA', description: 'PCR 산물' },
        { type: 'DNA', description: 'PCR 산물' },
      ],
      [{ DNA: { 'DNA-1': noAlias, 'DNA-3': { ...rec('named'), descriptions: ['PCR 산물 A'] } } }],
      new Set()
    );
    expect(out.fresh).toEqual([
      { type: 'DNA', alias: 'kit', description: '정제 카트리지 키트 RX-96' },
      { type: 'Plasmid', description: '정제 카트리지 키트 RX-96' },
      { type: 'DNA', description: 'PCR 산물' },
    ]);
    expect(out.skipped).toBe(2);
  });

  it('keeps only the first of two extracted entries for one sample', () => {
    const out = skipKnownSamples(
      [
        { type: 'DNA', alias: 'a' },
        { type: 'DNA', alias: 'A' },
      ],
      [],
      new Set()
    );
    expect(out).toEqual({ fresh: [{ type: 'DNA', alias: 'a' }], skipped: 1 });
  });
});

// ── extractSamplesCommand ────────────────────────────────────────

const DIR = 'labnote/001_Test';
const NOTE = `${DIR}/001_WD010_A.labnote.md`;
const LOCAL = `${DIR}/resources/labsamples`;
const GLOBAL = 'resources/labsamples';
const BODY = ['## [WD010 A]', '', '영하 20도 냉동고 2칸의 pUC19 플라스미드와 @DNA;DNA-9;기존 을 썼다.', ''].join('\n');
const LLM = { llmProvider: 'openai', llmEndpointOpenai: 'https://llm.example.test', llmModel: 'llama3.1' } as const;
const CONFLICTED = '<<<<<<< HEAD\n{"DNA-1":{}}\n=======\n{"DNA-2":{}}\n>>>>>>> other\n';

/** OpenAI 모양의 2xx 답. */
const reply = (content: string) => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) });
const registry = (recs: Record<string, { alias: string | null; descriptions?: string[] }>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(recs).map(([id, r]) => [id, { alias: r.alias, descriptions: r.descriptions ?? [], sources: [], location: null }])
    )
  );

type Message = { role: string; content: string };

let hosts: TestHost[] = [];
let offs: Array<() => void> = [];

const VAULT = () => ({ root: 'C:/Vault', name: 'Vault' });

async function setup(
  files: Record<string, string>,
  content: string,
  settings: Record<string, unknown> = LLM,
  routes: Record<string, (args: Record<string, unknown>) => unknown> = {}
) {
  const th = createTestHost({ [NOTE]: BODY, ...files }, settings);
  hosts.push(th);
  await th.mount(NOTE);
  const f = fakeInvoke({ llm_chat: () => reply(content), net_cancel: () => null, vault_current: VAULT, ...routes });
  const changed: Array<readonly string[] | undefined> = [];
  offs.push(sampleEvents.subscribe((p) => changed.push(p)));
  return { th, f, changed, env: createAiEnv(th.ctx, f.invoke) };
}

const sent = (f: ReturnType<typeof fakeInvoke>): Message[][] =>
  f.calls.filter(([c]) => c === 'llm_chat').map(([, a]) => (a.body as { messages: Message[] }).messages);
type Rec = { alias?: string | null; location?: string | null; descriptions?: string[]; sources?: string[] };
const records = (th: TestHost, path: string): Record<string, Rec> => JSON.parse(th.vault.files()[path]);

beforeEach(() => setLang('en'));
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  for (const th of hosts) th.cleanup();
  hosts = [];
  closeAllDialogs();
  cleanupDialogs();
  vi.restoreAllMocks();
});

describe('extractSamplesCommand', () => {
  // #530: '영하 20도 냉동고 2칸' was registered as '-20°C freezer shelf 2'.
  it('asks the sample extraction to keep what the note wrote, untranslated', async () => {
    const { f, env } = await setup({}, '[]');
    await extractSamplesCommand(env);
    const [messages] = sent(f);
    expect(messages[0].content).toContain(
      'Copy "alias", "description" and "location" in the language and wording the text uses; never translate them.'
    );
    expect(messages[1]).toEqual({ role: 'user', content: BODY });
  });

  it('asks nothing when no provider is configured', async () => {
    const { th, f, env } = await setup({}, '[]', { llmProvider: 'none' });
    await extractSamplesCommand(env);
    expect(sent(f)).toHaveLength(0);
    expect(th.notes).toContainEqual({ kind: 'info', message: t('ai.configureFirst') });
  });

  it('says so when the reply holds no samples', async () => {
    const { th, env } = await setup({}, 'I could not find any samples.');
    await extractSamplesCommand(env);
    expect(th.notes).toContainEqual({ kind: 'info', message: 'No samples found.' });
  });

  it('sends at most 6000 characters of the note', async () => {
    const long = `${BODY}${'가'.repeat(7000)}`;
    const th = createTestHost({ [NOTE]: long }, LLM);
    hosts.push(th);
    await th.mount(NOTE);
    const f = fakeInvoke({ llm_chat: () => reply('[]'), net_cancel: () => null, vault_current: VAULT });
    await extractSamplesCommand(createAiEnv(th.ctx, f.invoke));
    expect(sent(f)[0][1].content).toBe(long.slice(0, 6000));
  });

  it('skips samples already in the local or global registry or referenced in the note', async () => {
    const { th, env } = await setup(
      {
        [`${LOCAL}/DNA.json`]: registry({ 'DNA-1': { alias: null } }),
        [`${GLOBAL}/DNA.json`]: registry({ 'DNA-2': { alias: 'pUC19' } }),
      },
      JSON.stringify([
        { type: 'DNA', id: 'DNA-1' },
        { type: 'DNA', alias: 'PUC19' },
        { type: 'DNA', id: 'DNA-9' },
        { type: 'DNA', alias: 'new', location: '영하 20도 냉동고 2칸' },
      ])
    );
    await extractSamplesCommand(env);
    expect(th.notes).toContainEqual({
      kind: 'info',
      message: 'Created 1 new sample(s); skipped 3 already registered or in the note.',
    });
    const local = records(th, `${LOCAL}/DNA.json`);
    expect(Object.keys(local)).toHaveLength(2);
    expect(Object.values(local).find(r => r.alias === 'new')?.location).toBe('영하 20도 냉동고 2칸');
    expect(Object.keys(records(th, `${GLOBAL}/DNA.json`))).toEqual(['DNA-2']);
  });

  it('creates the rest through create_sample with no per-sample approval', async () => {
    const { th, env, changed } = await setup(
      {},
      '```json\n[{"type":"DNA","alias":"a","description":"PCR 산물"},{"type":"Plasmid","id":"Plasmid-4","alias":"pUC19","location":"시약장"}]\n```'
    );
    const confirm = vi.spyOn(th.host, 'confirm');
    await extractSamplesCommand(env);
    expect(confirm).not.toHaveBeenCalled();
    expect(th.asked.confirm).toHaveLength(0);
    expect(Object.values(records(th, `${LOCAL}/DNA.json`))).toEqual([
      expect.objectContaining({ alias: 'a', descriptions: ['PCR 산물'], sources: ['001_WD010_A.labnote.md'] }),
    ]);
    expect(records(th, `${LOCAL}/Plasmid.json`)['Plasmid-4']).toEqual(expect.objectContaining({ alias: 'pUC19', location: '시약장' }));
    expect(th.notes).toContainEqual({
      kind: 'info',
      message: 'Created 2 sample(s). 1 have no storage location; add it with Edit sample in the Samples view.',
    });
    // The index, the completion cache and the panel hear about the written registries.
    expect(changed).toContainEqual(expect.arrayContaining([`${LOCAL}/DNA.json`, `${LOCAL}/Plasmid.json`]));
  });

  it('warns when aliases were renamed to fit the alias rules', async () => {
    const { th, env } = await setup({}, JSON.stringify([{ type: 'DNA', alias: '대장균_형질전환', location: 'box' }]));
    await extractSamplesCommand(env);
    expect(th.notes).toContainEqual({
      kind: 'warn',
      message: 'Created 1 sample(s). Aliases changed to fit the alias rules (_ : ; # * become - or go): 대장균_형질전환 → 대장균-형질전환',
    });
  });

  it('allowed types come from the custom sample types', async () => {
    const { th, f, env } = await setup({}, JSON.stringify([{ type: 'strain', alias: 'BL21', location: 'box' }]), {
      ...LLM,
      customSampleTypes: ['Strain'],
    });
    await extractSamplesCommand(env);
    expect(sent(f)[0][0].content).toMatch(/"type" must be one of: [^.]*\bStrain\b/);
    expect(Object.values(records(th, `${LOCAL}/Strain.json`))).toEqual([expect.objectContaining({ alias: 'BL21' })]);
  });

  // D11: the open vault was switched while the model answered — the relative registry paths now name the other vault.
  it('writes nothing once the vault root changed during the request', async () => {
    let root = 'C:/A';
    const { th, env, changed } = await setup(
      {},
      JSON.stringify([{ type: 'DNA', alias: 'a', location: 'box' }]),
      LLM,
      {
        vault_current: () => ({ root, name: 'v' }),
        llm_chat: () => {
          root = 'C:/B';
          return reply(JSON.stringify([{ type: 'DNA', alias: 'a', location: 'box' }]));
        },
      }
    );
    const before = { ...th.vault.files() };
    await extractSamplesCommand(env);
    expect(th.vault.files()).toEqual(before);
    expect(th.notes.filter(n => n.message.startsWith('Created'))).toHaveLength(0);
    expect(changed).toHaveLength(0);
  });

  it('stops the creations when the vault is switched between them', async () => {
    let checks = 0;
    const { th, env, changed } = await setup(
      {},
      JSON.stringify([
        { type: 'DNA', alias: 'a', location: 'box' },
        { type: 'Plasmid', alias: 'p', location: 'box' },
      ]),
      LLM,
      {
        vault_current: () => {
          // 1: the guard is taken; 2..: one check per registry write. The switch lands after the first registry.
          checks++;
          if (Object.keys(th.vault.files()).some(p => p.endsWith('/DNA.json'))) void cancelAllRequests(async () => null as never);
          return VAULT();
        },
      }
    );
    await extractSamplesCommand(env);
    expect(checks).toBeGreaterThan(1);
    expect(Object.values(records(th, `${LOCAL}/DNA.json`))).toEqual([expect.objectContaining({ alias: 'a' })]);
    expect(th.vault.files()[`${LOCAL}/Plasmid.json`]).toBeUndefined();
    expect(th.notes.filter(n => n.message.startsWith('Created'))).toHaveLength(0);
    // The old vault's registry paths are not announced into the new one.
    expect(changed).toHaveLength(0);
  });

  it('a conflicted registry is reported and nothing is written for that type', async () => {
    const { th, env } = await setup(
      { [`${LOCAL}/DNA.json`]: CONFLICTED },
      JSON.stringify([
        { type: 'DNA', alias: 'a', location: 'box' },
        { type: 'DNA', alias: 'b', location: 'box' },
        { type: 'Plasmid', alias: 'p', location: 'box' },
      ])
    );
    await extractSamplesCommand(env);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
    expect(Object.values(records(th, `${LOCAL}/Plasmid.json`))).toEqual([expect.objectContaining({ alias: 'p' })]);
    expect(th.notes).toContainEqual({ kind: 'info', message: 'Created 1 sample(s).' });
    const unreadable = t('samples.registryUnreadable', `${LOCAL}/DNA.json`);
    expect(th.notes.filter(n => n.kind === 'warn' && n.message === unreadable)).toHaveLength(1);
  });
});
