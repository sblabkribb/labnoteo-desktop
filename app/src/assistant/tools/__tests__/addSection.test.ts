/**
 * `add_section`(assistant plan Task 11A, spec §4.4): 도우미만 쓰는 도구. 새 제목의 섹션을 노트 끝이나 `after` 섹션 뒤에
 * 붙이고, 같은 제목과 연구자만 쓰는 섹션은 거절하며, 실험 밖 경로는 확인을 묻기 전에 막는다. 쓰기는 도구 문맥의
 * `writeNote`(편집기를 아는 쓰기, 보관함 지킴이의 `beforeWrite`)로만 한다.
 */
import { MemFileSystem, previewTool, runTool, type SectionEditPreview, type ToolDef } from '@labnoteo/core';
import { buildApprovalMessage } from '../../../labnote/port/approvalMessage';
import { coreT } from '../../../labnote/i18n';
import type { ScopedToolContext } from '../../../labnote/context/contextTools';
import type { Scope } from '../../../labnote/context/scope';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { addSectionTool, addSectionText, type AddSectionPreview } from '../addSection';
import { assistantTools } from '../index';

const DIR = 'labnote/001_Test';
const NOTE = `${DIR}/001_WD010_A.labnote.md`;
const OUTSIDE = 'labnote/002_Other/001_WD010_B.labnote.md';
const BODY = [
  '## [WD010 A]',
  '',
  '### [UHW010 Liquid handling]',
  '',
  '#### Method',
  '',
  'pipette 10 uL',
  '',
  '#### Output',
  '',
  '## Results & Discussions',
  '',
  'band at 1 kb',
  '',
].join('\n');
const scope: Scope = { folder: DIR, explicit: false, named: [] };

function setup(files: Record<string, string> = { [NOTE]: BODY }, extra: Partial<ScopedToolContext> = {}) {
  const fs = new MemFileSystem(files);
  const order: string[] = [];
  const ctx: ScopedToolContext = {
    fs,
    workspaceRoot: '.',
    scope,
    async writeNote(path, content) {
      order.push('beforeWrite');
      order.push(`write:${path}`);
      await fs.write(path, content);
    },
    ...extra,
  };
  return { fs, ctx, order };
}

const tool = (): ToolDef => addSectionTool(scope);
const run = (ctx: ScopedToolContext, args: Record<string, unknown>) => runTool([tool()], 'add_section', ctx, args);

beforeEach(() => setLang('en'));

describe('add_section', () => {
  it('is a mutating tool with documentPath, heading, body and after', () => {
    const def = tool();
    expect(def.name).toBe('add_section');
    expect(def.mutates).toBe(true);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(['after', 'body', 'documentPath', 'heading']);
    expect(def.inputSchema.required).toEqual(['documentPath', 'heading', 'body']);
  });

  it('assistantTools(scope) offers add_section and search_catalog', () => {
    expect(assistantTools(scope).map((x) => x.name)).toEqual(['add_section', 'search_catalog']);
    expect(assistantTools(undefined).map((x) => x.name)).toEqual(['add_section', 'search_catalog']);
  });

  it('describe gives a sectionEdit preview with the added lines and nothing removed', async () => {
    const { ctx } = setup();
    const p = (await previewTool(tool(), ctx, { documentPath: NOTE, heading: 'Notes', body: 'first line\nsecond line' })) as AddSectionPreview;
    expect(p).toMatchObject({
      kind: 'sectionEdit',
      adding: true,
      documentPath: NOTE,
      heading: 'Notes',
      removedLines: 0,
      removedText: [],
      clearing: false,
      addedText: ['## Notes', 'first line', 'second line'],
      addedMore: 0,
    });
    expect(p.after).toBeUndefined();
    // Hosts that know only sectionEdit still render it.
    const msg = buildApprovalMessage(coreT, 'Allow?', NOTE, p as SectionEditPreview);
    expect(msg).toContain('first line');
  });

  it('addSectionText words the preview in the app language: at the end, or after a heading', async () => {
    const { ctx } = setup();
    const end = (await previewTool(tool(), ctx, { documentPath: NOTE, heading: 'Notes', body: 'x' })) as AddSectionPreview;
    expect(addSectionText(end)).toContain(t('assistant.addSection.atEnd', 'Notes'));
    expect(addSectionText(end)).toContain('## Notes');
    const after = (await previewTool(tool(), ctx, { documentPath: NOTE, heading: 'Notes', body: 'x', after: 'Method' })) as AddSectionPreview;
    expect(after.after).toBe('Method');
    expect(addSectionText(after)).toContain(t('assistant.addSection.after', 'Notes', 'Method'));
    setLang('ko');
    expect(addSectionText(after)).toContain('Method');
    expect(addSectionText(after)).toMatch(/추가/);
  });

  it('appends "## heading" and the body at the end of the note', async () => {
    const { ctx, fs } = setup();
    const res = await run(ctx, { documentPath: NOTE, heading: 'Notes', body: 'first line' });
    expect(res.ok).toBe(true);
    expect(await fs.read(NOTE)).toBe(`${BODY.trimEnd()}\n\n## Notes\n\nfirst line\n`);
  });

  it('a leading "#" in the heading and a repeated heading line in the body are dropped', async () => {
    const { ctx, fs } = setup();
    await run(ctx, { documentPath: NOTE, heading: '## Notes', body: '## Notes\n\nfirst line' });
    expect(await fs.read(NOTE)).toBe(`${BODY.trimEnd()}\n\n## Notes\n\nfirst line\n`);
  });

  it('after a heading: inserted at the end of that section, at its level, before the next heading', async () => {
    const { ctx, fs } = setup();
    const res = await run(ctx, { documentPath: NOTE, heading: 'Parameters', body: 'speed 3', after: 'Method' });
    expect(res.ok).toBe(true);
    expect(await fs.read(NOTE)).toContain('#### Method\n\npipette 10 uL\n\n#### Parameters\n\nspeed 3\n\n#### Output');
  });

  it('after a heading that is not in the note: refused, nothing written', async () => {
    const { ctx, fs, order } = setup();
    const res = await run(ctx, { documentPath: NOTE, heading: 'Parameters', body: 'x', after: 'Nowhere' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nowhere/);
    expect(order).toEqual([]);
    expect(await fs.read(NOTE)).toBe(BODY);
  });

  it('refuses a heading its new neighbours already have (any case, brackets ignored)', async () => {
    const { ctx, fs, order } = setup();
    for (const [heading, after] of [
      ['Method', 'Output'],
      ['method', 'Output'],
      ['[WD010 A]', undefined],
      ['wd010 a', undefined],
    ] as const) {
      const res = await run(ctx, { documentPath: NOTE, heading, body: 'x', ...(after ? { after } : {}) });
      expect(res.ok, heading).toBe(false);
      expect(res.error).toMatch(/already/i);
    }
    const preview = await previewTool(tool(), ctx, { documentPath: NOTE, heading: 'method', body: 'x', after: 'Output' });
    expect(preview).toMatchObject({ error: expect.stringMatching(/already/i) });
    expect(order).toEqual([]);
    expect(await fs.read(NOTE)).toBe(BODY);
  });

  it('refuses the researcher-only sections, in English or Korean', async () => {
    const { ctx, fs } = setup({ [NOTE]: '## [WD010 A]\n\ntext\n' });
    for (const heading of ['Results & Discussions', 'results and discussion', 'QC Metrics', 'Discussion', 'Meta', '결과', '논의']) {
      const res = await run(ctx, { documentPath: NOTE, heading, body: 'x' });
      expect(res.ok, heading).toBe(false);
      expect(res.error).toMatch(/researcher/i);
    }
    expect(await fs.read(NOTE)).toBe('## [WD010 A]\n\ntext\n');
  });

  it('a path outside the experiment is refused before describe and the handler read anything', async () => {
    const { ctx, fs, order } = setup({ [NOTE]: BODY, [OUTSIDE]: '## B\n' });
    const read = vi.spyOn(fs, 'read');
    const res = await run(ctx, { documentPath: OUTSIDE, heading: 'Notes', body: 'x' });
    expect(res).toMatchObject({ ok: false, code: 'outOfScope' });
    const preview = await previewTool(tool(), ctx, { documentPath: OUTSIDE, heading: 'Notes', body: 'x' });
    expect(preview).toMatchObject({ code: 'outOfScope' });
    expect(read).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(await fs.read(OUTSIDE)).toBe('## B\n');
  });

  it('a folder the user named (allowedFolders) is in scope; ".." and non-.md paths are not', async () => {
    const { ctx, fs } = setup({ [NOTE]: BODY, [OUTSIDE]: '## B\n' }, { allowedFolders: new Set(['labnote/002_Other']) });
    expect((await run(ctx, { documentPath: OUTSIDE, heading: 'Notes', body: 'x' })).ok).toBe(true);
    expect(await fs.read(OUTSIDE)).toContain('## Notes');
    for (const documentPath of [`${DIR}/../003_X/x.md`, `${DIR}/data.json`, '/etc/x.md']) {
      expect((await run(ctx, { documentPath, heading: 'Notes', body: 'x' })).ok, documentPath).toBe(false);
    }
  });

  it('without a scope it still refuses unsafe paths', async () => {
    const fs = new MemFileSystem({ [NOTE]: BODY });
    const ctx: ScopedToolContext = { fs, workspaceRoot: '.' };
    const def = addSectionTool(undefined);
    for (const documentPath of ['../x.md', 'C:/x.md', '.obsidian/x.md', 'a/b.txt', '/abs.md']) {
      expect((await runTool([def], 'add_section', ctx, { documentPath, heading: 'N', body: 'x' })).ok, documentPath).toBe(false);
    }
    expect((await runTool([def], 'add_section', ctx, { documentPath: NOTE, heading: 'N', body: 'x' })).ok).toBe(true);
  });

  it('writes only through writeNote, so the vault guard (beforeWrite) runs first; a failed guard writes nothing', async () => {
    const { ctx, fs, order } = setup();
    const write = vi.spyOn(fs, 'write');
    await run(ctx, { documentPath: NOTE, heading: 'Notes', body: 'x' });
    expect(order).toEqual(['beforeWrite', `write:${NOTE}`]);
    expect(write).toHaveBeenCalledTimes(1);

    const fs2 = new MemFileSystem({ [NOTE]: BODY });
    const write2 = vi.spyOn(fs2, 'write');
    const modify2 = vi.spyOn(fs2, 'modify');
    const guarded: ScopedToolContext = {
      fs: fs2,
      workspaceRoot: '.',
      scope,
      writeNote: async () => {
        throw new Error('vault changed');
      },
    };
    const res = await run(guarded, { documentPath: NOTE, heading: 'Notes', body: 'x' }).catch((err: Error) => ({ ok: false, error: err.message }));
    expect(res.ok).toBe(false);
    expect(write2).not.toHaveBeenCalled();
    expect(modify2).not.toHaveBeenCalled();
    expect(await fs2.read(NOTE)).toBe(BODY);
  });

  it('a missing note, an empty heading, a multi-line heading or a body heading as high as the new one is refused', async () => {
    const { ctx } = setup();
    expect((await run(ctx, { documentPath: `${DIR}/none.md`, heading: 'N', body: 'x' })).error).toMatch(/not found/i);
    expect((await run(ctx, { documentPath: NOTE, heading: '  ', body: 'x' })).ok).toBe(false);
    expect((await run(ctx, { documentPath: NOTE, heading: 'a\nb', body: 'x' })).ok).toBe(false);
    expect((await run(ctx, { documentPath: NOTE, heading: 'N', body: 'x\n## Other\ny' })).error).toMatch(/Other/);
    expect((await run(ctx, { documentPath: NOTE, heading: 'N2', body: 'x\n### Deeper\ny' })).ok).toBe(true);
  });

  it('keeps CRLF line endings', async () => {
    const crlf = BODY.replace(/\n/g, '\r\n');
    const { ctx, fs } = setup({ [NOTE]: crlf });
    await run(ctx, { documentPath: NOTE, heading: 'Notes', body: 'a\nb' });
    const md = await fs.read(NOTE);
    expect(md).toBe(`${crlf.trimEnd()}\r\n\r\n## Notes\r\n\r\na\r\nb\r\n`);
  });
});
