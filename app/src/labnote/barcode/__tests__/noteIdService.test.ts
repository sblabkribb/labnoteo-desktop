// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LabnoteHost } from '@labnoteo/core';
import { parseFrontMatterYaml } from '@labnoteo/core';
import { readNoteId } from '@labnoteo/core/lib/noteId';
import { createFakeVault } from '../../../__tests__/fakeVault';
import { setComposing } from '../../../editor/__tests__/composing';
import { TauriLabnoteFs } from '../../../fs/tauriLabnoteFs';
import { editorAwareFs } from '../../editorAwareFs';
import { coreT } from '../../i18n';
import { NoteBusyError } from '../../noteErrors';
import { mountEditor } from '../../__tests__/editorHarness';
import { NoteIdService, isBarcodeNote, previousNoteIdFromScans, type NoteIdSource } from '../../port/noteIdService';
import { NoteIdIndex, type NoteRef } from '../noteIdIndex';
import { appNoteIdSource, noteRef } from '../noteIdSource';

describe('NoteIdService', () => {
  const note = (id?: string) => `---\ntitle: x\n${id ? `labnote_id: ${id}\n` : ''}---\n\nbody\n`;

  /** vendor tests/plugin/barcode.test.ts 의 stub App 자리에 메모리 위 NoteIdSource. ID 는 지금 글에서 읽는다. */
  function service(
    notes: Record<string, { text: string; ctime: number }>,
    /** What the restore question is answered with; null closes it. */
    answer: 'restore' | 'new' | 'cancel' | null = 'restore',
  ) {
    const files = new Map(Object.entries(notes));
    const fileOf = (p: string): NoteRef => ({
      path: p,
      basename: p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, ''),
      ctime: files.get(p)!.ctime,
    });
    const notices: string[] = [];
    const source: NoteIdSource = {
      files: () => [...files.keys()].map(fileOf),
      idOf: (p) => (files.has(p) ? readNoteId(files.get(p)!.text) : undefined),
      read: async (p) => files.get(p)!.text,
      process: async (p, fn) => {
        files.get(p)!.text = fn(files.get(p)!.text);
      },
      exists: (p) => files.has(p),
    };
    const host = {
      notify: (_level: string, msg: string) => notices.push(msg),
      t: (s: string) => s,
      confirm: async () => true,
      pick: async () => answer ?? undefined,
    } as unknown as LabnoteHost;
    return { svc: new NoteIdService(source, host), files, fileOf, notices };
  }

  it('lab notes are *.labnote.md, in any case', () => {
    expect(isBarcodeNote('x/A.LabNote.md')).toBe(true);
    expect(isBarcodeNote('templates/block.md')).toBe(false);
  });

  it('finds notes by ID and gives a note without one a fresh, unused ID', async () => {
    const { svc, files, fileOf } = service({ 'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 }, 'b.labnote.md': { text: note(), ctime: 2 } });
    expect(svc.filesWithId('LN-AAAAAAAA').map((f) => f.path)).toEqual(['a.labnote.md']);
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBe('LN-AAAAAAAA');
    const id = await svc.ensureId(fileOf('b.labnote.md'));
    expect(id).toMatch(/^LN-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(id).not.toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('b.labnote.md')!.text)).toBe(id);
  });

  it('leaves a note with broken front matter unchanged', async () => {
    const broken = '---\ntitle: [unclosed\n---\n';
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text: broken, ctime: 1 } });
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBeUndefined();
    expect(files.get('a.labnote.md')!.text).toBe(broken);
    expect(notices).toHaveLength(1);
  });

  it('does not touch last_updated_date when it gives an ID', async () => {
    const text = '---\ntitle: x\nlast_updated_date: 2026-01-02\n---\n\nbody\n';
    const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } });
    const id = await svc.ensureId(fileOf('a.labnote.md'));
    expect(files.get('a.labnote.md')!.text).toBe(`---\ntitle: x\nlabnote_id: ${id}\nlast_updated_date: 2026-01-02\n---\n\nbody\n`);
  });

  // #236: printed worksheets carry the old ID.
  const scanned = (embed: string) =>
    `${note()}\n#### Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=056ac8eeaf37 -->\n${embed}\n*caption*\n`;

  it('reads the ID a note was printed under from its filed scans', () => {
    expect(previousNoteIdFromScans(scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg|200]]'))).toBe('LN-FK5Q8KV0');
    expect(previousNoteIdFromScans(scanned('![[images/scans/LN-FK5Q8KV0_u1_p1_20261021_2.jpg]]'))).toBe('LN-FK5Q8KV0');
    expect(previousNoteIdFromScans(scanned('![200](images/scans/LN-FK5Q8KV0_u0_p1_20261021.jpg)'))).toBe('LN-FK5Q8KV0');
    expect(previousNoteIdFromScans(scanned('![[photo.jpg]]'))).toBeUndefined();
    expect(previousNoteIdFromScans(note())).toBeUndefined();
  });

  it('offers the ID back when the labnote_id line was lost', async () => {
    const { svc, files, fileOf } = service({
      'a.labnote.md': { text: scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]'), ctime: 1 },
    });
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBe('LN-FK5Q8KV0');
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-FK5Q8KV0');
  });

  // #267: closing the question must not be read as "give a new ID".
  it('gives a new ID only when that is what was picked, and changes nothing on cancel', async () => {
    const text = scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]');
    for (const answer of ['cancel', null] as const) {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, answer);
      expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ reason: 'cancelled' });
      expect(await svc.ensureId(fileOf('a.labnote.md'))).toBeUndefined();
      expect(files.get('a.labnote.md')!.text).toBe(text);
    }
    const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    const id = await svc.ensureId(fileOf('a.labnote.md'));
    expect(id).toMatch(/^LN-/);
    expect(id).not.toBe('LN-FK5Q8KV0');
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe(id);
  });

  // #478: an ID edited out of the format was silently replaced.
  it('restores an ID that only lost its capitals', async () => {
    const { svc, files, fileOf, notices } = service({ 'a.labnote.md': { text: note('ln-r4w7tz04'), ctime: 1 } });
    expect(await svc.ensureId(fileOf('a.labnote.md'))).toBe('LN-R4W7TZ04');
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-R4W7TZ04');
    expect(notices).toEqual(['The labnote_id of {0} was written as "{1}"; restored it as {2}.']);
  });

  it('asks before replacing any other malformed ID, and changes nothing on cancel', async () => {
    const text = note("'LN-냉동고 정리 1'");
    for (const answer of ['cancel', null] as const) {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, answer);
      expect(await svc.ensureIdResult(fileOf('a.labnote.md'))).toEqual({ reason: 'cancelled' });
      expect(files.get('a.labnote.md')!.text).toBe(text);
    }
    const { svc, files, fileOf } = service({ 'a.labnote.md': { text, ctime: 1 } }, 'new');
    const id = await svc.ensureId(fileOf('a.labnote.md'));
    expect(readNoteId(files.get('a.labnote.md')!.text)).toBe(id);
  });

  it('asks about a lower-case ID another note already holds instead of restoring it', async () => {
    const { svc, fileOf } = service(
      {
        'orig.labnote.md': { text: note('LN-R4W7TZ04'), ctime: 1 },
        'copy.labnote.md': { text: note('ln-r4w7tz04'), ctime: 2 },
      },
      'cancel',
    );
    expect(await svc.ensureIdResult(fileOf('copy.labnote.md'))).toEqual({ reason: 'cancelled' });
  });

  it('gives a new ID, with a warning, when another note holds the old one', async () => {
    const { svc, fileOf, notices } = service({
      'orig.labnote.md': { text: note('LN-FK5Q8KV0'), ctime: 1 },
      'copy.labnote.md': { text: scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]'), ctime: 2 },
    });
    const id = await svc.ensureId(fileOf('copy.labnote.md'));
    expect(id).not.toBe('LN-FK5Q8KV0');
    expect(notices).toHaveLength(1);
  });

  it('does not offer the old ID when a new one is asked for', async () => {
    const { svc, fileOf } = service({
      'a.labnote.md': { text: scanned('![[LN-FK5Q8KV0_u1_p1_20261021.jpg]]'), ctime: 1 },
    });
    expect(await svc.ensureId(fileOf('a.labnote.md'), { reassign: true })).not.toBe('LN-FK5Q8KV0');
  });

  it('reports a copied ID once and re-numbers the newer note', async () => {
    const { svc, files } = service({
      'orig.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'copy.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 5 },
    });
    await svc.offerDuplicateFixes();
    expect(readNoteId(files.get('orig.labnote.md')!.text)).toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('copy.labnote.md')!.text)).not.toBe('LN-AAAAAAAA');
    files.get('copy.labnote.md')!.text = note('LN-AAAAAAAA');
    expect(svc.unreportedDuplicates()).toEqual([]);
  });

  // #425
  it('asks again about the notes still sharing an ID, and about a note joining them', async () => {
    const { svc, files } = service({
      'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'b.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 2 },
      'c.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 3 },
    });
    await svc.offerDuplicateFixes();
    const ids = ['a', 'b', 'c'].map((n) => readNoteId(files.get(`${n}.labnote.md`)!.text));
    expect(ids[0]).toBe('LN-AAAAAAAA');
    expect(new Set(ids).size).toBe(3);

    files.set('d.labnote.md', { text: note('LN-AAAAAAAA'), ctime: 4 });
    expect(svc.unreportedDuplicates().map((d) => d.newest.path)).toEqual(['d.labnote.md']);
    expect(svc.unreportedDuplicates()).toEqual([]);
  });

  it('does not ask again about notes left sharing an ID after a cancel', async () => {
    const { svc, files } = service({
      'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'b.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 2 },
    });
    let asked = 0;
    (svc as unknown as { host: { confirm: () => Promise<boolean> } }).host.confirm = async () => (asked++, false);
    await svc.offerDuplicateFixes();
    await svc.offerDuplicateFixes();
    expect(asked).toBe(1);
    files.set('c.labnote.md', { text: note('LN-AAAAAAAA'), ctime: 3 });
    await svc.offerDuplicateFixes();
    expect(asked).toBe(2);
  });

  it('a note that shares its ID with a lab note or a template says so', () => {
    const { svc, fileOf } = service({
      'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'b.labnote.md': { text: note('LN-BBBBBBBB'), ctime: 2 },
      'templates/block.md': { text: note('LN-BBBBBBBB'), ctime: 3 },
      'c.labnote.md': { text: note('LN-CCCCCCCC'), ctime: 4 },
      'd.labnote.md': { text: note('LN-CCCCCCCC'), ctime: 5 },
    });
    expect(svc.sharesId(fileOf('a.labnote.md'))).toBe(false);
    expect(svc.sharesId(fileOf('b.labnote.md'))).toBe(true);
    expect(svc.sharesId(fileOf('c.labnote.md'))).toBe(true);
    expect(svc.filesOutsideLabNotesWithId('LN-BBBBBBBB').map((f) => f.path)).toEqual(['templates/block.md']);
  });

  // #426
  it('leaves a template carrying an ID out, and warns about it once', async () => {
    const { svc, files, notices } = service({
      'labnote/101/001_WD010.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
      'labnote/102/001_WT010.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 2 },
      'templates/block.md': { text: note('LN-AAAAAAAA'), ctime: 3 },
    });
    expect(svc.filesWithId('LN-AAAAAAAA')).toHaveLength(2);
    await svc.offerDuplicateFixes();
    expect(readNoteId(files.get('templates/block.md')!.text)).toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('labnote/101/001_WD010.labnote.md')!.text)).toBe('LN-AAAAAAAA');
    expect(readNoteId(files.get('labnote/102/001_WT010.labnote.md')!.text)).not.toBe('LN-AAAAAAAA');
    expect(notices.filter((n) => n.includes('not a lab note'))).toHaveLength(1);
    await svc.offerDuplicateFixes();
    expect(notices.filter((n) => n.includes('not a lab note'))).toHaveLength(1);
  });

  // #443: merging notes left the kept note with the merged one's ID.
  describe('a changed labnote_id', () => {
    const answering = (svc: NoteIdService, ok: boolean) => {
      const asked: string[] = [];
      (svc as unknown as { host: { confirm: (m: string) => Promise<boolean> } }).host.confirm = async (m) => (asked.push(m), ok);
      return asked;
    };

    it('offers the old ID back after a merge, before the duplicate it makes for a moment', async () => {
      const { svc, files, fileOf } = service({
        'kept.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
        'merged.labnote.md': { text: note('LN-BBBBBBBB'), ctime: 2 },
      });
      svc.rememberIds();
      const asked = answering(svc, true);
      files.get('kept.labnote.md')!.text = note('LN-BBBBBBBB');

      expect(await svc.checkIdChange(fileOf('kept.labnote.md'))).toBe(true);

      expect(asked).toEqual([
        'The labnote_id of {0} changed from {1} to {2} (by merging notes, say). Worksheets already printed as {1} will not find this note. Restore {1}?',
      ]);
      expect(readNoteId(files.get('kept.labnote.md')!.text)).toBe('LN-AAAAAAAA');
      expect(await svc.checkIdChange(fileOf('kept.labnote.md'))).toBe(false);
      expect(asked).toHaveLength(1);
    });

    it('keeps the new ID when the question is declined, and does not ask again', async () => {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 } });
      svc.rememberIds();
      const asked = answering(svc, false);
      files.get('a.labnote.md')!.text = note('LN-CCCCCCCC');

      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(true);
      expect(readNoteId(files.get('a.labnote.md')!.text)).toBe('LN-CCCCCCCC');
      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(false);
      expect(asked).toHaveLength(1);
    });

    it('does not ask about an ID labnoteo gave, nor one another note holds', async () => {
      const { svc, files, fileOf } = service({
        'orig.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 },
        'copy.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 5 },
        'b.labnote.md': { text: note('LN-BBBBBBBB'), ctime: 6 },
      });
      svc.rememberIds();
      const asked = answering(svc, true);

      // A re-numbered duplicate, and a copied experiment's renewed ID.
      await svc.offerDuplicateFixes();
      expect(await svc.checkIdChange(fileOf('copy.labnote.md'))).toBe(false);
      await svc.ensureId(fileOf('b.labnote.md'), { reassign: true });
      expect(await svc.checkIdChange(fileOf('b.labnote.md'))).toBe(false);

      // A colleague's fix of a duplicate, pulled: the original still holds the old ID.
      files.set('c.labnote.md', { text: note('LN-AAAAAAAA'), ctime: 7 });
      expect(await svc.checkIdChange(fileOf('c.labnote.md'))).toBe(false);
      files.get('c.labnote.md')!.text = note('LN-DDDDDDDD');
      expect(await svc.checkIdChange(fileOf('c.labnote.md'))).toBe(false);

      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('share the note ID');
    });

    it('follows a renamed note, and compares nothing before the IDs are remembered', async () => {
      const { svc, files, fileOf } = service({ 'a.labnote.md': { text: note('LN-AAAAAAAA'), ctime: 1 } });
      const asked = answering(svc, false);
      files.get('a.labnote.md')!.text = note('LN-CCCCCCCC');
      expect(await svc.checkIdChange(fileOf('a.labnote.md'))).toBe(false);

      svc.rememberIds();
      files.set('b.labnote.md', files.get('a.labnote.md')!);
      files.delete('a.labnote.md');
      svc.moveKnown('a.labnote.md', 'b.labnote.md');
      files.get('b.labnote.md')!.text = note('LN-AAAAAAAA');
      expect(await svc.checkIdChange(fileOf('b.labnote.md'))).toBe(true);
      expect(asked).toHaveLength(1);
    });
  });
});

describe('NoteIdService over the app (appNoteIdSource)', () => {
  /** 가짜 보관함 위의 editorAwareFs, 그 위의 진짜 NoteIdIndex, 그리고 받은 알림을 남기는 호스트. */
  async function app(files: Record<string, string>) {
    const vault = createFakeVault(files);
    const fs = editorAwareFs(new TauriLabnoteFs(vault.invoke));
    const index = new NoteIdIndex({
      files: async () => Object.keys(vault.files()).filter((p) => p.endsWith('.md')),
      read: (p) => fs.read(p),
      ctimes: async (ps) => ps.map(() => 1),
    });
    await index.ready();
    const notices: Array<{ kind: string; message: string }> = [];
    const host = {
      notify: (kind: string, message: string) => void notices.push({ kind, message }),
      t: coreT,
      confirm: async () => false,
      pick: async () => undefined,
    } as unknown as LabnoteHost;
    const svc = new NoteIdService(appNoteIdSource(index, fs), host);
    return { vault, fs, index, svc, notices };
  }

  it('ensureId on an open note that is composing writes nothing and throws NoteBusyError', async () => {
    const original = '---\ntitle: x\n---\nbody\n';
    const { vault, index, svc } = await app({ 'a.labnote.md': original });
    const m = mountEditor(vault, 'a.labnote.md');
    await m.loaded();
    const view = m.view();
    setComposing(view, true);
    await expect(svc.ensureId(noteRef(index, 'a.labnote.md')!)).rejects.toBeInstanceOf(NoteBusyError);
    expect(vault.files()['a.labnote.md']).not.toContain('labnote_id');
    expect(view.state.doc.toString()).toBe(original);
    setComposing(view, false);
    m.unmount();
  });

  it('writes labnote_id after title: and keeps CRLF', async () => {
    const { vault, index, svc } = await app({ 'a.labnote.md': '---\r\ntitle: x\r\n---\r\n' });
    const id = await svc.ensureId(noteRef(index, 'a.labnote.md')!);
    const text = vault.files()['a.labnote.md'];
    expect(text.split('\r\n')[2]).toMatch(/^labnote_id: LN-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(text.split('\r\n')[2]).toBe(`labnote_id: ${id}`);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(index.idOf('a.labnote.md')).toBe(id); // the index was refreshed after the write
  });

  it('refuses unreadable YAML with the plugin warning and writes nothing', async () => {
    const broken = '---\ntitle: [x\n---\n';
    const { vault, index, svc, notices } = await app({ 'a.labnote.md': broken });
    expect(await svc.ensureIdResult(noteRef(index, 'a.labnote.md')!)).toEqual({ reason: 'unreadable' });
    const parseError = parseFrontMatterYaml(broken).parseError!;
    expect(parseError).toBeTruthy();
    expect(notices).toEqual([
      {
        kind: 'warn',
        message: coreT(
          'Front matter of {0} could not be read, so it was left unchanged. Fix the YAML and try again: {1}',
          'a.labnote.md',
          parseError,
        ),
      },
    ]);
    expect(vault.files()['a.labnote.md']).toBe(broken);
  });

  it('writes nothing to a note deleted after it was indexed', async () => {
    const { vault, index, svc } = await app({ 'a.labnote.md': '---\ntitle: x\n---\n' });
    const ref = noteRef(index, 'a.labnote.md')!;
    await vault.invoke('vault_trash', { path: 'a.labnote.md' });
    await expect(svc.ensureId(ref)).rejects.toBeTruthy();
    expect(vault.files()['a.labnote.md']).toBeUndefined();
  });

  it('noteRef finds an indexed note and nothing else', async () => {
    const { index } = await app({ 'x/a.labnote.md': '' });
    expect(noteRef(index, 'x/a.labnote.md')).toMatchObject({ path: 'x/a.labnote.md', basename: 'a.labnote' });
    expect(noteRef(index, 'missing.md')).toBeUndefined();
  });
});
