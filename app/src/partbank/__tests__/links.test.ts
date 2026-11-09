// @vitest-environment jsdom
/**
 * labnoteo-import 과 labnoteo-open 링크(Task 24, D14). 앱은 OS 주소 체계를 등록하지 않는다: "labnoteO 링크 열기" 명령이
 * 붙여 넣은 링크를 받아 옮겨 온 처리기에 넘긴다. 어떤 웹 페이지든 이런 링크를 만들 수 있으니 매개변수는 믿지 않는다:
 * vendor tests/plugin/partbankUri.test.ts 와 labnoteOpenUri.test.ts 를 그대로 옮기고, 앱의 경우를 더한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSamplesByType } from '@labnoteo/core/lib/sampleStorage';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { deliverReference, handleImportUri, IMPORT_ACTION, parseImportRequest } from '../../labnote/port/partbankUri';
import { handleOpenUri, OPEN_ACTION, openPosition, parseOpenRequest } from '../../labnote/port/labnoteOpenUri';
import { insertSampleReference } from '../../labnote/port/sampleInsert';
import type { SampleEnv } from '../../samples/env';
import { parseLabnoteoLink, runOpenLabnoteoLink } from '../linkCommand';
import { PB_WEB, partbankRoutes, pbEnv, type PbEnv } from './pbFixture';

vi.mock('../../labnote/port/sampleInsert', async (orig) => ({
  ...(await orig<typeof import('../../labnote/port/sampleInsert')>()),
  insertSampleReference: vi.fn(),
}));

const OBJECT_ID = '507f1f77bcf86cd799439011';
const OID1 = OBJECT_ID;
const WEB = 'https://partbank.kbiofoundry.kr';
const GLOBAL = 'resources/labsamples';
const LOCAL = 'labnote/001_Exp/resources/labsamples';
const NOTE = 'labnote/001_Exp/001_WD010_A.labnote.md';
const VAULT_NAME = 'lab';

const writeText = vi.fn();
beforeEach(() => {
  setLang('en');
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText, readText: vi.fn(async () => '') } });
  vi.mocked(insertSampleReference).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseImportRequest', () => {
  it('reads a well-formed link', () => {
    expect(parseImportRequest({ server: ` ${WEB} `, type: 'part', id: ` ${OBJECT_ID} ` })).toEqual({
      server: WEB,
      type: 'part',
      id: OBJECT_ID,
    });
  });

  it('accepts the six partbank types, in any case', () => {
    for (const type of ['part', 'device', 'plasmid', 'primer', 'molecule', 'strain']) {
      expect(parseImportRequest({ server: WEB, type: type.toUpperCase(), id: OBJECT_ID })?.type).toBe(type);
    }
    expect(parseImportRequest({ server: WEB, type: 'storage', id: OBJECT_ID })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'vector', id: OBJECT_ID })).toBeUndefined();
  });

  // Only a Mongo ObjectId can name an item; a KID or a path cannot.
  it('refuses an id that is not a 24-character hex string', () => {
    expect(parseImportRequest({ server: WEB, type: 'part', id: 'KBp_aa0001' })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'part', id: OBJECT_ID.slice(1) })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'part', id: `${OBJECT_ID}/..` })).toBeUndefined();
    expect(parseImportRequest({ server: WEB, type: 'part', id: '' })).toBeUndefined();
  });

  it('refuses a server that is not an http(s) address', () => {
    expect(parseImportRequest({ server: '', type: 'part', id: OBJECT_ID })).toBeUndefined();
    expect(parseImportRequest({ server: 'partbank.kr', type: 'part', id: OBJECT_ID })).toBeUndefined();
    expect(parseImportRequest({ server: 'file:///etc/passwd', type: 'part', id: OBJECT_ID })).toBeUndefined();
    expect(parseImportRequest({ server: 'javascript:alert(1)', type: 'part', id: OBJECT_ID })).toBeUndefined();
  });

  it('refuses a link with parameters missing', () => {
    expect(parseImportRequest({})).toBeUndefined();
    expect(parseImportRequest({ server: WEB })).toBeUndefined();
    expect(parseImportRequest({ type: 'part', id: OBJECT_ID })).toBeUndefined();
  });

  // Renaming this would silently break the button in partbank.
  it('answers the action partbank links to', () => {
    expect(IMPORT_ACTION).toBe('labnoteo-import');
    expect(OPEN_ACTION).toBe('labnoteo-open');
  });
});

// #284: declining the insert still put the reference on the clipboard.
describe('deliverReference', () => {
  const target = { path: 'labnote/001_A/001_WD010_A.labnote.md', getCursorOffset: async () => 12 } as unknown as NonNullable<
    ReturnType<SampleEnv['editTarget']>
  >;
  let pb: PbEnv;
  const envWith = (open: boolean, tracked = true): SampleEnv => ({
    ...pb.env,
    editTarget: () => (open ? target : undefined),
    trackingFor: () => tracked,
  });
  beforeEach(() => {
    pb = pbEnv();
  });
  afterEach(() => pb.th.cleanup());

  it('inserts into the open note when confirmed', async () => {
    pb.th.answer.confirm(true);
    const env = envWith(true);
    expect(await deliverReference(env, 'DNA-1;pX')).toBe(target.path);
    // The cursor read before the confirmation is handed on, since the dialog
    // leaves the editor reporting the start of the note (#544).
    expect(insertSampleReference).toHaveBeenCalledWith(env, target, 'DNA-1;pX', 12);
    expect(pb.th.asked.confirm[0].message).toBe('Insert DNA-1;pX into the open note?');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does nothing when the insert is declined', async () => {
    pb.th.answer.confirm(false);
    expect(await deliverReference(envWith(true), 'DNA-1;pX')).toBeUndefined();
    expect(insertSampleReference).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(pb.th.notes).toEqual([]);
  });

  it('copies without asking when no tracked note is open', async () => {
    for (const env of [envWith(false), envWith(true, false)]) await deliverReference(env, 'DNA-1;pX');
    expect(pb.th.asked.confirm).toEqual([]);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(pb.th.notes.map((n) => n.message)).toEqual(['Copied DNA-1;pX to the clipboard.', 'Copied DNA-1;pX to the clipboard.']);
  });

  it('a refused clipboard is told, not thrown', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    await deliverReference(envWith(false), 'DNA-1;pX');
    expect(pb.th.notes.map((n) => n.message)).toEqual([t('samples.copyRefused', 'DNA-1;pX')]);
  });
});

const TYPES = ['DNA', 'Plasmid', 'Strain'];
const FILE = 'labnote/001_GFP/002_WB140.labnote.md';

describe('parseOpenRequest', () => {
  it('reads a note link with a sample and a heading', () => {
    expect(
      parseOpenRequest({ vault: 'lab', file: ` ${FILE} `, type: 'dna', sample: ' DNA-1 ', heading: ' Methods ' }, TYPES),
    ).toEqual({ file: FILE, sample: { type: 'DNA', id: 'DNA-1' }, heading: 'Methods' });
  });

  it('reads a note link alone', () => {
    expect(parseOpenRequest({ file: FILE }, TYPES)).toEqual({ file: FILE });
  });

  it('refuses paths outside the vault or not a Markdown note', () => {
    for (const file of [
      '',
      '/etc/passwd.md',
      'C:/Users/x/note.md',
      '../outside.md',
      'labnote/../../x.md',
      './x.md',
      'labnote/run.sh',
      'a'.repeat(1025) + '.md',
    ]) {
      expect(parseOpenRequest({ file }, TYPES), file).toBeUndefined();
    }
  });

  it('normalizes Windows separators', () => {
    expect(parseOpenRequest({ file: 'labnote\\001\\n.labnote.md' }, TYPES)?.file).toBe('labnote/001/n.labnote.md');
  });

  it('needs a known type and an id together', () => {
    expect(parseOpenRequest({ file: FILE, type: 'Gene', sample: 'G-1' }, TYPES)).toBeUndefined();
    expect(parseOpenRequest({ file: FILE, type: 'DNA' }, TYPES)).toBeUndefined();
    expect(parseOpenRequest({ file: FILE, sample: 'DNA-1' }, TYPES)).toBeUndefined();
    expect(parseOpenRequest({ file: FILE, type: 'DNA', sample: 'x'.repeat(201) }, TYPES)).toBeUndefined();
  });

  it('refuses an overlong heading', () => {
    expect(parseOpenRequest({ file: FILE, heading: 'h'.repeat(301) }, TYPES)).toBeUndefined();
  });
});

describe('openPosition', () => {
  const text = [
    '# Note', // 0
    '## Methods', // 1
    'Mix @DNA;DNA-1 with buffer.', // 2
    '## Results', // 3
    'Band of @DNA;DNA-1 at 3 kb.', // 4
  ].join('\n');

  it('prefers the reference under the asked heading', () => {
    const at = openPosition(text, { file: FILE, sample: { type: 'DNA', id: 'DNA-1' }, heading: 'Note › Results' }, []);
    expect(at.line).toBe(4);
  });

  it('falls back to the first reference, then to the top', () => {
    expect(openPosition(text, { file: FILE, sample: { type: 'DNA', id: 'DNA-1' }, heading: 'Gone' }, []).line).toBe(2);
    expect(openPosition(text, { file: FILE, sample: { type: 'DNA', id: 'DNA-9' } }, [])).toEqual({ line: 0, ch: 0 });
    expect(openPosition(text, { file: FILE }, [])).toEqual({ line: 0, ch: 0 });
  });
});

describe('parseLabnoteoLink', () => {
  it('parses the four link forms and nothing else', () => {
    expect(parseLabnoteoLink('obsidian://labnoteo-import?server=https%3A%2F%2Fpb&type=plasmid&id=' + OID1)?.action).toBe('import');
    expect(parseLabnoteoLink('labnoteo://open?vault=lab&file=a.labnote.md')?.action).toBe('open');
    for (const s of ['javascript:alert(1)', 'https://x/labnoteo-import', 'obsidian://open?vault=x', '']) expect(parseLabnoteoLink(s)).toBeUndefined();
  });

  it('decodes the parameters, trims the link and ignores the scheme case', () => {
    expect(parseLabnoteoLink('  OBSIDIAN://labnoteo-import?server=https%3A%2F%2Fpb&type=plasmid&id=' + OID1 + '\n')).toEqual({
      action: 'import',
      params: { server: 'https://pb', type: 'plasmid', id: OID1 },
    });
    expect(parseLabnoteoLink('obsidian://labnoteo-open?vault=lab&file=labnote%2Fa%20b.labnote.md')).toEqual({
      action: 'open',
      params: { vault: 'lab', file: 'labnote/a b.labnote.md' },
    });
    expect(parseLabnoteoLink('Labnoteo://import?type=part')?.action).toBe('import');
  });

  it('refuses look-alikes', () => {
    for (const s of [
      'obsidian://labnoteo-importx?type=part',
      'obsidian://labnoteo-delete?file=a.md',
      'labnoteo://export?x=1',
      'obsidian:labnoteo-import?type=part',
      'xobsidian://labnoteo-import?type=part',
      'see obsidian://labnoteo-import?type=part',
    ]) {
      expect(parseLabnoteoLink(s), s).toBeUndefined();
    }
  });

  it('keeps the first of a repeated parameter', () => {
    expect(parseLabnoteoLink('labnoteo://open?file=a.md&file=b.md')?.params.file).toBe('a.md');
  });
});

describe('Open labnoteO link', () => {
  let pb: PbEnv;
  const sent = () => pb.calls.filter((c) => c[0] === 'partbank_request');
  const messages = () => pb.th.notes.map((n) => n.message);
  const run = (clip: string) =>
    runOpenLabnoteoLink(pb.th.ctx, async () => clip, { feature: pb.feature, invoke: pb.invoke });
  const importLink = (q: string) => `obsidian://labnoteo-import?${q}`;

  function setup(
    files: Record<string, string> = { [NOTE]: '# A\n' },
    answers: Record<string, unknown> = {},
    settings: NonNullable<Parameters<typeof pbEnv>[1]>['settings'] = {},
  ): void {
    pb?.th.cleanup();
    pb = pbEnv(files, {
      settings: { globalSampleFolder: GLOBAL, ...settings },
      routes: {
        ...partbankRoutes(answers),
        vault_current: () => ({ root: 'C:/vaults/lab', name: VAULT_NAME, hasObsidianConfig: false }),
      },
    });
  }
  beforeEach(() => setup());
  afterEach(() => pb.th.cleanup());

  it('server param never supplies an address', async () => {
    const link = importLink(`server=${encodeURIComponent('https://evil.example')}&type=part&id=${OID1}`);
    pb.th.answer.prompt((o) => o.value);
    await run(link);
    expect(sent()).toEqual([]);
    expect(pb.th.notes).toEqual([
      { kind: 'warn', message: coreT('That link points at a partbank that is not set up here ({0}).', 'https://evil.example') },
    ]);
  });

  it('only selects a configured connection: the call goes to the configured web origin', async () => {
    setup({ [NOTE]: '# A\n' }, { [`/parts/${OID1}`]: { id: OID1, kid: 'KBp_1', name: 'sfGFP' }, [`/stock-box/by-resource/part/${OID1}`]: { items: [] } });
    pb.th.setActive(NOTE);
    // The link names the configured origin (a trailing slash is the same origin): it selects the web connection; Rust uses the stored address.
    const link = importLink(`server=${encodeURIComponent(PB_WEB + '/')}&type=part&id=${OID1}`);
    pb.th.answer.prompt((o) => o.value);
    pb.th.answer.pick(LOCAL);
    await run(link);
    expect(sent().map((c) => c[1].path)).toEqual([`/parts/${OID1}`, `/stock-box/by-resource/part/${OID1}`]);
    for (const c of sent()) expect(c[1]).not.toHaveProperty('url');
    const records = await loadSamplesByType(pb.env.fs, LOCAL, 'DNA');
    expect(Object.values(records)).toEqual([expect.objectContaining({ alias: 'sfGFP' })]);
    expect(pb.th.asked.pick[0].opts?.title).toBe(coreT('Register "{0}" from partbank as a {1} sample where?', 'sfGFP', 'DNA'));
    const id = Object.keys(records)[0];
    // No open editor in this test: the reference goes to the clipboard.
    expect(writeText).toHaveBeenCalledWith(`${id};sfGFP`);
  });

  it('outside an experiment asks once, for the global registry', async () => {
    setup({ 'loose.md': '# L\n' }, { [`/parts/${OID1}`]: { id: OID1, name: 'sfGFP' }, [`/stock-box/by-resource/part/${OID1}`]: { items: [] } });
    pb.th.setActive('loose.md');
    pb.th.answer.prompt((o) => o.value);
    pb.th.answer.confirm(false);
    await run(importLink(`server=${encodeURIComponent(PB_WEB)}&type=part&id=${OID1}`));
    expect(pb.th.asked.confirm[0]).toEqual({
      message: coreT('Register "{0}" from partbank as a {1} sample in {2}?', 'sfGFP', 'DNA', GLOBAL),
      opts: { confirmLabel: coreT('Register') },
    });
    expect(await loadSamplesByType(pb.env.fs, GLOBAL, 'DNA')).toEqual({});
  });

  it('rejects an id that is not an ObjectId and a non-http server', async () => {
    for (const q of [
      `server=${encodeURIComponent(PB_WEB)}&type=part&id=KBp_aa0001`,
      `server=${encodeURIComponent('file:///C:/x')}&type=part&id=${OID1}`,
      `server=${encodeURIComponent('javascript:alert(1)')}&type=part&id=${OID1}`,
      `server=${encodeURIComponent(PB_WEB)}&type=storage&id=${OID1}`,
    ]) {
      pb.th.answer.prompt((o) => o.value);
      await run(importLink(q));
    }
    expect(sent()).toEqual([]);
    expect(messages()).toEqual(Array(4).fill(coreT('That partbank link is not something labnoteo can read.')));
  });

  it('a partbank error is said in the plugin words, never the raw text', async () => {
    setup({ [NOTE]: '# A\n' }, {});
    pb.th.answer.prompt((o) => o.value);
    await run(importLink(`server=${encodeURIComponent(PB_WEB)}&type=part&id=${OID1}`));
    expect(sent()).toHaveLength(1);
    expect(messages().join('\n')).not.toContain('raw-rust-text');
    expect(pb.th.notes[0].kind).toBe('error');
  });

  it('open link opens the note at the sample reference', async () => {
    const text = '# Note\n## Methods\nMix @DNA;DNA-1 with buffer.\n';
    setup({ [FILE]: text });
    const open = vi.spyOn(pb.th.ctx, 'openFile');
    pb.th.answer.prompt((o) => o.value);
    await run(`obsidian://labnoteo-open?vault=${VAULT_NAME}&file=${encodeURIComponent(FILE)}&type=DNA&sample=DNA-1`);
    expect(open).toHaveBeenCalledWith(FILE, { line: 2, ch: expect.any(Number) });
    expect(pb.th.notes).toEqual([]);
  });

  it('open link refuses another vault and over-long paths', async () => {
    setup({ [FILE]: '# N\n' });
    const open = vi.spyOn(pb.th.ctx, 'openFile');
    pb.th.answer.prompt((o) => o.value);
    await run(`obsidian://labnoteo-open?vault=other&file=${encodeURIComponent(FILE)}`);
    pb.th.answer.prompt((o) => o.value);
    await run(`labnoteo://open?file=${'a'.repeat(1025)}.md`);
    pb.th.answer.prompt((o) => o.value);
    await run(`labnoteo://open?file=${encodeURIComponent('../x.md')}`);
    pb.th.answer.prompt((o) => o.value);
    await run(`labnoteo://open?file=${encodeURIComponent('labnote/missing.labnote.md')}`);
    expect(open).not.toHaveBeenCalled();
    expect(messages()).toEqual([
      t('partbank.linkOtherVault', 'other'),
      coreT('That note link is not something labnoteo can read.'),
      coreT('That note link is not something labnoteo can read.'),
      coreT('Could not find the note: {0}', 'labnote/missing.labnote.md'),
    ]);
  });

  it('the vault name is matched without regard to case, and a link without one opens here', async () => {
    setup({ [FILE]: '# N\n' });
    const open = vi.spyOn(pb.th.ctx, 'openFile');
    pb.th.answer.prompt((o) => o.value, (o) => o.value);
    await run(`labnoteo://open?vault=LAB&file=${encodeURIComponent(FILE)}`);
    await run(`labnoteo://open?file=${encodeURIComponent(FILE)}`);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('clipboard is used only when it holds a link', async () => {
    pb.th.answer.prompt(undefined);
    await run('just some copied text');
    expect(pb.th.asked.prompt[0].value ?? '').toBe('');
    expect(pb.th.asked.prompt[0].prompt).toBe(t('partbank.linkPrompt'));

    const link = `labnoteo://open?file=${encodeURIComponent(FILE)}`;
    pb.th.answer.prompt(undefined);
    await run(`  ${link}  `);
    expect(pb.th.asked.prompt[1].value).toBe(link);

    // A clipboard that cannot be read leaves the field empty.
    pb.th.answer.prompt(undefined);
    await runOpenLabnoteoLink(pb.th.ctx, () => Promise.reject(new Error('denied')), { feature: pb.feature, invoke: pb.invoke });
    expect(pb.th.asked.prompt[2].value ?? '').toBe('');
    expect(pb.th.notes).toEqual([]);
  });

  it('an invalid link is refused with the app sentence, and the prompt says so while typing', async () => {
    pb.th.answer.prompt('https://example.com/not-a-link');
    await run('');
    expect(pb.th.notes).toEqual([{ kind: 'warn', message: t('partbank.linkInvalid') }]);
    const validate = pb.th.asked.prompt[0].validate!;
    expect(await validate('nope')).toBe(t('partbank.linkInvalid'));
    expect(await validate(`labnoteo://open?file=${encodeURIComponent(FILE)}`)).toBeFalsy();
  });

  it('an import link with partbank switched off points at Integration settings', async () => {
    pb.th.answer.prompt((o) => o.value);
    await runOpenLabnoteoLink(pb.th.ctx, async () => importLink(`server=${encodeURIComponent(PB_WEB)}&type=part&id=${OID1}`), {
      feature: undefined,
      invoke: pb.invoke,
    });
    expect(messages()).toEqual([t('partbank.setupFirst')]);
    expect(sent()).toEqual([]);
  });

  it('the strings exist in ko and en', () => {
    setLang('ko');
    expect(t('cmd.openLabnoteoLink')).toBe('labnoteO 링크 열기');
    expect(t('partbank.linkPrompt')).toBe('붙여 넣을 labnoteO 링크');
    expect(t('partbank.linkInvalid')).toBe('알 수 없는 링크입니다.');
    setLang('en');
    expect(t('cmd.openLabnoteoLink')).toBe('Open labnoteO link');
    expect(t('partbank.linkPrompt')).toBe('labnoteO link to open');
    expect(t('partbank.linkInvalid')).toBe('This is not a labnoteO link.');
  });
});

describe('handlers called directly', () => {
  it('handleImportUri and handleOpenUri refuse bad parameters before any call', async () => {
    const pb = pbEnv();
    await handleImportUri(pb.env, pb.feature, { server: 'https://x', type: 'part', id: 'bad' });
    await handleOpenUri(pb.env, { file: '../x.md' });
    expect(pb.calls.filter((c) => c[0] === 'partbank_request')).toEqual([]);
    expect(pb.th.notes.map((n) => n.message)).toEqual([
      coreT('That partbank link is not something labnoteo can read.'),
      coreT('That note link is not something labnoteo can read.'),
    ]);
    pb.th.cleanup();
  });
});
