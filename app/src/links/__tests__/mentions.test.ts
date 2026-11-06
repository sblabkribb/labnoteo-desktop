import { describe, expect, it, vi } from 'vitest';
import { NoteChangedError } from '../../labnote/noteErrors';
import { MENTION_LIMIT, findMentions, linkMention, mentionNames, unlinkedMentions } from '../mentions';

describe('mentions', () => {
  it('finds plain mentions, with Korean particles, outside links and code', () => {
    const text = '---\ntitle: PCR 조건\n---\nPCR 조건을 바꿨다. [[PCR 조건]] `PCR 조건` xPCR 조건';
    expect(findMentions(text, ['PCR 조건']).map((m) => [m.line, m.text])).toEqual([[3, 'PCR 조건']]);
  });
  it('finds two-syllable Korean names', () => {
    expect(findMentions('배지를 바꿨다', ['배지']).map((m) => m.text)).toEqual(['배지']);
  });
  it('names skip one-character ones, strip extensions, and use the README title', () => {
    expect(mentionNames('labnote/061_a/001_prep.labnote.md', { aliases: ['P', 'Prep step'] })).toEqual(['001_prep', 'Prep step']);
    expect(mentionNames('notes/배지.md', { aliases: [] })).toEqual(['배지']);
    expect(mentionNames('labnote/061_a/README.labnote.md', { aliases: [], title: '061 PCR 최적화' })).toEqual(['061 PCR 최적화']);
    expect(mentionNames('labnote/061_a/README.labnote.md', { aliases: [] })).toEqual([]);
  });
  it('links one mention, keeping the matched spelling as alias', () => {
    expect(linkMention('a pcr 조건 b', { line: 0, text: 'pcr 조건', nth: 0 }, 'PCR 조건')).toBe('a [[PCR 조건|pcr 조건]] b');
    expect(linkMention('a PCR 조건 b', { line: 0, text: 'PCR 조건', nth: 0 }, 'PCR 조건')).toBe('a [[PCR 조건]] b');
    expect(() => linkMention('changed', { line: 0, text: 'PCR 조건', nth: 0 }, 'PCR 조건')).toThrow(NoteChangedError);
  });
  it('escapes the alias separator inside a table row', () => {
    const t = '| a | b |\n|---|---|\n| x | pcr 조건 |';
    const out = linkMention(t, { line: 2, text: 'pcr 조건', nth: 0 }, 'PCR 조건');
    expect(out).toBe('| a | b |\n|---|---|\n| x | [[PCR 조건\\|pcr 조건]] |');
    expect(out.split('\n')[2].split(/(?<!\\)\|/).length).toBe(4);
  });
  it('keeps a BOM and CRLF', () => {
    expect(linkMention('\uFEFFa\r\nPCR 조건\r\n', { line: 1, text: 'PCR 조건', nth: 0 }, 'PCR 조건')).toBe('\uFEFFa\r\n[[PCR 조건]]\r\n');
  });
  it('links the nth mention on a line and reports it gone when there are fewer', () => {
    expect(linkMention('배지 and 배지', { line: 0, text: '배지', nth: 1 }, '배지')).toBe('배지 and [[배지]]');
    expect(() => linkMention('배지', { line: 0, text: '배지', nth: 1 }, '배지')).toThrow(NoteChangedError);
  });
  it('queries search per name with the full limit and drops the target itself', async () => {
    const search = vi.fn(async () => ({ hits: [{ path: 'notes/PCR 조건.md' }, { path: 'a.md' }], truncated: false }));
    const out = await unlinkedMentions('notes/PCR 조건.md', { search, read: async () => 'uses PCR 조건 daily', meta: { aliases: [] } });
    expect(out.groups.map((o) => o.source)).toEqual(['a.md']);
    expect(search).toHaveBeenCalledWith('PCR 조건', MENTION_LIMIT);
    expect(out.truncated).toBe(false);
  });
  it('reports a truncated search', async () => {
    const out = await unlinkedMentions('notes/배지.md', { search: async () => ({ hits: [{ path: 'a.md' }], truncated: true }), read: async () => '배지', meta: { aliases: [] } });
    expect(out.truncated).toBe(true);
  });
});
