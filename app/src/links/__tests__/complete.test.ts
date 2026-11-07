// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { labnoteMarkdown } from '../../editor/markdownSyntax';
import { setComposing } from '../../editor/__tests__/composing';
import { createResolver } from '../resolve';
import { subpathLine } from '../subpath';
import type { OutlineItem } from '../../editor/outline/extract';
import { COMPLETION_MAX, wikiCompletionSource, wikiContext, type WikiCompletionDeps } from '../complete';

const files = ['Home.md', 'notes/PCR 조건.md', 'notes/sub/PCR 조건.md', 'notes/pcr.md', 'images/gel.png', 'labnote/061_a/README.labnote.md', 'labnote/062_b/README.labnote.md', 'labnote/061_a/001_prep.labnote.md'];
const aliases = [{ path: 'notes/pcr.md', alias: '중합' }];
const titles = new Map([['labnote/061_a/README.labnote.md', '061 PCR 최적화'], ['labnote/062_b/README.labnote.md', '062 전기영동']]);

const headings = new Map<string, OutlineItem[]>();

const deps: WikiCompletionDeps = {
  notePath: () => 'n.md',
  snapshot: () => ({ files, aliases, titles, resolver: createResolver(files) }),
  headings: async (path) => headings.get(path) ?? [],
};
const source = wikiCompletionSource(deps);

async function complete(doc: string, pos = doc.length, composing = false): Promise<CompletionResult | null> {
  const state = EditorState.create({ doc, extensions: [labnoteMarkdown()] });
  const ctx = new CompletionContext(state, pos, false, { composing } as unknown as EditorView);
  return (await source(ctx)) as CompletionResult | null;
}

/** Runs `option.apply` on a real view over `doc` with the cursor at `pos`, as the completion plugin would. */
function applied(doc: string, option: Completion, pos = doc.length, composing = false): { doc: string; head: number } {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: pos }, extensions: [labnoteMarkdown()] }),
    parent: document.body,
  });
  if (composing) setComposing(view, true);
  const line = view.state.doc.lineAt(pos);
  const ctx = wikiContext(line.text.slice(0, pos - line.from))!;
  const from = pos - (ctx.heading ? ctx.heading.query.length : ctx.query.length);
  (option.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, option, from, pos);
  const out = { doc: view.state.doc.toString(), head: view.state.selection.main.head };
  if (composing) setComposing(view, false);
  view.destroy();
  return out;
}

describe('wikilink completion', () => {
  it('COMPLETION_MAX is 50', () => expect(COMPLETION_MAX).toBe(50));

  it('detects the wikilink context', () => {
    expect(wikiContext('see [[PCR')).toEqual({ embed: false, query: 'PCR' });
    expect(wikiContext('![[ge')).toEqual({ embed: true, query: 'ge' });
    expect(wikiContext('[[PCR 조건#St')).toEqual({ embed: false, query: '', heading: { linkpath: 'PCR 조건', query: 'St' } });
    expect(wikiContext('[[a|b')).toBeNull();
    expect(wikiContext('[[a]] x')).toBeNull();
    expect(wikiContext('[x')).toBeNull();
  });

  it('lists notes, applies the shortest link text, and absorbs ]]', async () => {
    const r = (await complete('[[hom'))!;
    expect(r.options[0].label).toBe('Home');
    expect(applied('[[hom', r.options[0])).toEqual({ doc: '[[Home]]', head: 8 });
    expect(applied('[[hom]]', r.options[0], 5)).toEqual({ doc: '[[Home]]', head: 8 });
  });

  it('ambiguous names insert the path form and show the folder', async () => {
    const r = (await complete('x [[PCR 조'))!;
    expect(r.options.map((o) => [o.label, o.detail])).toEqual([['PCR 조건', 'notes'], ['PCR 조건', 'notes/sub']]);
    expect(applied('x [[PCR 조', r.options[1]).doc).toBe('x [[notes/sub/PCR 조건]]');
  });

  it('alias rows insert target|alias', async () => {
    const r = (await complete('[[중합'))!;
    expect(r.options[0]).toMatchObject({ label: '중합', detail: 'pcr' });
    expect(applied('[[중합', r.options[0]).doc).toBe('[[pcr|중합]]');
  });

  it('labnote titles are searchable, shown, and written as the alias', async () => {
    const r = (await complete('[[전기영동'))!;
    expect(r.options[0]).toMatchObject({ label: 'README', detail: '062 전기영동 · labnote/062_b' });
    expect(applied('[[전기영동', r.options[0]).doc).toBe('[[labnote/062_b/README.labnote|062 전기영동]]');
  });

  it('labnote notes are listed without .labnote and inserted in the Obsidian form', async () => {
    const r = (await complete('[[001_pr'))!;
    expect(r.options[0]).toMatchObject({ label: '001_prep', detail: 'labnote/061_a' });
    expect(applied('[[001_pr', r.options[0]).doc).toBe('[[001_prep.labnote]]');
    // the full name still finds it
    expect((await complete('[[001_prep.labnote'))!.options[0].label).toBe('001_prep');
    // an alias row names its note without .labnote too
    const withAlias = wikiCompletionSource({
      ...deps,
      snapshot: () => ({ files, aliases: [{ path: 'labnote/061_a/001_prep.labnote.md', alias: '미니프렙' }], titles, resolver: createResolver(files) }),
    });
    const state = EditorState.create({ doc: '[[미니', extensions: [labnoteMarkdown()] });
    const a = (await withAlias(new CompletionContext(state, 4, false, { composing: false } as unknown as EditorView))) as CompletionResult;
    expect(a.options[0]).toMatchObject({ label: '미니프렙', detail: '001_prep' });
    expect(applied('[[미니', a.options[0]).doc).toBe('[[001_prep.labnote|미니프렙]]');
  });

  it('inside a table row the alias separator is escaped', async () => {
    const doc = '| a | b |\n|---|---|\n| x | [[중합';
    const r = (await complete(doc))!;
    const out = applied(doc, r.options[0]).doc;
    expect(out).toBe('| a | b |\n|---|---|\n| x | [[pcr\\|중합]]');
    // still two cells: the leading '' before the first pipe, ' x ' and the link (the row has no closing pipe)
    expect(out.split('\n')[2].split(/(?<!\\)\|/).slice(1)).toEqual([' x ', ' [[pcr\\|중합]]']);
  });

  it('a title or alias holding a pipe or ]] is not written as the alias', async () => {
    const odd = wikiCompletionSource({
      ...deps,
      snapshot: () => ({
        files,
        aliases,
        titles: new Map([['labnote/061_a/README.labnote.md', 'PCR | 최적화'], ['labnote/062_b/README.labnote.md', '062 ]] 전기영동']]),
        resolver: createResolver(files),
      }),
    });
    const run = async (doc: string) => {
      const state = EditorState.create({ doc, extensions: [labnoteMarkdown()] });
      return (await odd(new CompletionContext(state, doc.length, false, { composing: false } as unknown as EditorView))) as CompletionResult;
    };
    const t1 = await run('[[최적화');
    expect(applied('[[최적화', t1.options[0]).doc).toBe('[[README.labnote]]');
    const doc = '| a |\n|---|\n| [[최적화';
    expect(applied(doc, (await run(doc)).options[0]).doc).toBe('| a |\n|---|\n| [[README.labnote]]');
    expect(applied('[[전기영동', (await run('[[전기영동')).options[0]).doc).toBe('[[labnote/062_b/README.labnote]]');
  });

  it('images only after ![[', async () => {
    expect((await complete('[[gel'))!.options.map((o) => o.label)).not.toContain('gel.png');
    const r = (await complete('![[gel'))!;
    expect(applied('![[gel', r.options[0]).doc).toBe('![[gel.png]]');
  });

  it('returns no completions in code', async () => {
    expect(await complete('`[[ho')).toBeNull();
    expect(await complete('```\n[[ho')).toBeNull();
  });

  it('returns null while the index is not ready', async () => {
    const s = wikiCompletionSource({ ...deps, snapshot: () => null });
    const state = EditorState.create({ doc: '[[ho', extensions: [labnoteMarkdown()] });
    expect(await s(new CompletionContext(state, 4, false))).toBeNull();
  });

  it('keeps the list open and filtering while a syllable composes', async () => {
    const r = (await complete('[[중합', 4, true))!;
    expect(r.options[0].label).toBe('중합');
  });

  it('apply does nothing while composing', async () => {
    const r = (await complete('[[중합'))!;
    expect(applied('[[중합', r.options[0], 4, true).doc).toBe('[[중합');
  });

  it('lists the target note headings after #, sanitised on insert', async () => {
    headings.set('Home.md', [{ level: 1, text: 'Intro', line: 1, kind: 'heading' }, { level: 2, text: 'Step 1: PCR', line: 2, kind: 'heading' }, { level: 2, text: 'Sample #3', line: 3, kind: 'heading' }]);
    const r = (await complete('[[Home#st'))!;
    expect(r.options.map((o) => o.label)).toEqual(['Step 1: PCR']);
    expect(applied('[[Home#st', r.options[0]).doc).toBe('[[Home#Step 1 PCR]]');
    const s = (await complete('[[Home#sam'))!;
    expect(applied('[[Home#sam', s.options[0]).doc).toBe('[[Home#Sample 3]]');
    expect(subpathLine('# Intro\n## Step 1: PCR\n## Sample #3\n', { subpath: 'Sample 3' })).toBe(2);
  });

  it('heading insertion absorbs ]] and does nothing while composing', async () => {
    headings.set('Home.md', [{ level: 2, text: 'Step 1: PCR', line: 2, kind: 'heading' }]);
    const r = (await complete('[[Home#st]]', 9))!;
    expect(applied('[[Home#st]]', r.options[0], 9)).toEqual({ doc: '[[Home#Step 1 PCR]]', head: 19 });
    const c = (await complete('[[Home#st', 9, true))!;
    expect(c.options.map((o) => o.label)).toEqual(['Step 1: PCR']);
    expect(applied('[[Home#st', c.options[0], 9, true).doc).toBe('[[Home#st');
  });

  it('[[# lists this note headings', async () => {
    const r = (await complete('# Top\n[[#', 9))!;
    expect(applied('# Top\n[[#', r.options[0], 9).doc).toBe('# Top\n[[#Top]]');
  });

  it('no headings for an unresolved note', async () => {
    expect(await complete('[[Nope#')).toBeNull();
  });
});
