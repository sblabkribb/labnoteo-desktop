import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import {
  ASSISTANT_HISTORY_ERROR_KINDS,
  AssistantHistoryError,
  clearAllHistory,
  clearHistory,
  emptyHistory,
  historyStats,
  readHistory,
  toHistoryError,
  toWireDoc,
  writeHistory,
  type HistoryDoc,
} from '../history';

const NFD = '002_세포 배양'.normalize('NFD');
const NFC = '002_세포 배양'.normalize('NFC');

describe('assistant history IPC client', () => {
  it('error kinds are exactly the ones Rust serialises', () => {
    const pinned = JSON.parse(readFileSync('src-tauri/tests/ipc-assistant-errors.json', 'utf-8')) as Record<string, string>;
    expect([...ASSISTANT_HISTORY_ERROR_KINDS].sort()).toEqual(Object.values(pinned).sort());
  });

  it('readHistory sends only the folder, NFC-normalised', async () => {
    expect(NFD).not.toBe(NFC);
    const doc = emptyHistory(NFC);
    const f = fakeInvoke({ assistant_history_read: () => ({ doc, token: 'a'.repeat(32) }) });
    expect(await readHistory(NFD, f.invoke)).toEqual({ doc, token: 'a'.repeat(32) });
    expect(f.calls).toEqual([['assistant_history_read', { folder: NFC }]]);
  });

  it('writeHistory sends only folder, token and a doc with known fields', async () => {
    const f = fakeInvoke({ assistant_history_write: () => null });
    const doc = {
      version: 1,
      folder: 'whatever',
      updated: 7,
      root: 'C:\\other-vault',
      summary: { text: 's', tainted: true, covers: 4, raw: 'x' },
      messages: [
        { id: 'u1', role: 'user', text: 'hi', ts: 1, chip: 'unitOp', pending: true },
        {
          id: 'a1',
          role: 'assistant',
          text: 'answer [1]',
          ts: 2,
          tainted: true,
          toolResults: ['fetched page body'],
          sources: [{ kind: 'web', label: 'L', target: 'https://example.org/', text: 'page body' }],
        },
      ],
    } as unknown as HistoryDoc;
    await writeHistory(NFD, 'b'.repeat(32), doc, f.invoke);
    expect(f.calls).toHaveLength(1);
    const [cmd, args] = f.calls[0];
    expect(cmd).toBe('assistant_history_write');
    expect(Object.keys(args).sort()).toEqual(['doc', 'folder', 'token']);
    expect(args.folder).toBe(NFC);
    expect(args.token).toBe('b'.repeat(32));
    expect(args.doc).toEqual({
      version: 1,
      folder: NFC,
      updated: 7,
      summary: { text: 's', tainted: true, covers: 4 },
      messages: [
        { id: 'u1', role: 'user', text: 'hi', ts: 1, chip: 'unitOp' },
        {
          id: 'a1',
          role: 'assistant',
          text: 'answer [1]',
          ts: 2,
          tainted: true,
          sources: [{ kind: 'web', label: 'L', target: 'https://example.org/' }],
        },
      ],
    });
    const sent = JSON.stringify(args);
    for (const leak of ['root', 'other-vault', 'fetched page body', 'page body', 'pending', 'raw', 'key', 'path']) {
      expect(sent).not.toContain(leak);
    }
  });

  it('toWireDoc leaves out absent optionals and does not mutate the input', () => {
    const doc: HistoryDoc = { version: 1, folder: 'A', updated: 0, messages: [{ id: '1', role: 'user', text: 't', ts: 1 }] };
    const copy = structuredClone(doc);
    const wire = toWireDoc(doc);
    expect(wire).toEqual(doc);
    expect('summary' in wire).toBe(false);
    expect('tainted' in wire.messages[0]).toBe(false);
    expect(doc).toEqual(copy);
  });

  it('clear, clear-all and stats send nothing but the folder', async () => {
    const f = fakeInvoke({
      assistant_history_clear: () => null,
      assistant_history_clear_all: () => 3,
      assistant_history_stats: () => ({ folders: 2, bytes: 900 }),
    });
    await clearHistory(NFD, f.invoke);
    expect(await clearAllHistory(f.invoke)).toBe(3);
    expect(await historyStats(f.invoke)).toEqual({ folders: 2, bytes: 900 });
    expect(f.calls).toEqual([
      ['assistant_history_clear', { folder: NFC }],
      ['assistant_history_clear_all', {}],
      ['assistant_history_stats', {}],
    ]);
  });

  it('a Rust rejection becomes an AssistantHistoryError with its kind', async () => {
    for (const kind of ASSISTANT_HISTORY_ERROR_KINDS) {
      const f = fakeInvoke({
        assistant_history_write: () => {
          throw { kind, message: 'raw' };
        },
      });
      const err = await writeHistory('A', 't', emptyHistory('A'), f.invoke).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AssistantHistoryError);
      expect(err).toMatchObject({ kind, message: 'raw' });
    }
  });

  it('an unknown or malformed rejection is io', () => {
    expect(toHistoryError({ kind: 'mystery', message: 'm' }).kind).toBe('io');
    expect(toHistoryError('plain')).toMatchObject({ kind: 'io', message: 'plain' });
    expect(toHistoryError(null).kind).toBe('io');
    const e = new AssistantHistoryError('vaultChanged', 'x');
    expect(toHistoryError(e)).toBe(e);
  });

  it('emptyHistory is version 1 with no messages', () => {
    expect(emptyHistory(NFD)).toEqual({ version: 1, folder: NFC, updated: 0, messages: [] });
  });
});
