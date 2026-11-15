// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { saveVaultSettings, useVaultSettings } from '../settings';

type Inv = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function store(connections: Record<string, unknown> | null) {
  const writes: Array<Record<string, unknown>> = [];
  const invoke: Inv = async (cmd, args) => {
    if (cmd === 'settings_vault_read') return JSON.stringify({ autoSyncUnitOpToc: true });
    if (cmd === 'settings_connections') return { values: connections ? JSON.stringify(connections) : null, damaged: false };
    if (cmd === 'settings_vault_write') {
      writes.push(JSON.parse(String(args?.content)));
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  };
  return { invoke: invoke as never, writes };
}

describe('a stale window must not revert connection settings', () => {
  it('flipping an unrelated option sends no connection key', async () => {
    const s = store(null);
    const { result } = renderHook(() => useVaultSettings('v', s.invoke));
    await waitFor(() => expect(result.current.settings).toBeTruthy());
    await act(async () => {
      await result.current.update({ autoSyncUnitOpToc: false });
    });
    expect(s.writes).toHaveLength(1);
    expect(s.writes[0].autoSyncUnitOpToc).toBe(false);
    for (const k of ['llmProvider', 'llmModel', 'llmEndpointOpenai', 'partbankWebUrl', 'allowHttpOrigins', 'mcpClientServers']) {
      expect(k in s.writes[0]).toBe(false);
    }
  });

  it('changing the LLM model sends only that connection key', async () => {
    const s = store(null);
    const { result } = renderHook(() => useVaultSettings('v', s.invoke));
    await waitFor(() => expect(result.current.settings).toBeTruthy());
    await act(async () => {
      await result.current.update({ llmModel: 'gpt-x', llmProvider: result.current.settings!.llmProvider });
    });
    expect(s.writes[0].llmModel).toBe('gpt-x');
    expect('llmProvider' in s.writes[0]).toBe(false);
  });

  it('saveVaultSettings without a key set still sends everything (first start)', async () => {
    const s = store(null);
    const { result } = renderHook(() => useVaultSettings('v', s.invoke));
    await waitFor(() => expect(result.current.settings).toBeTruthy());
    await saveVaultSettings(result.current.settings!, s.invoke);
    expect(s.writes[0].llmProvider).toBeDefined();
  });
});

describe('limits match the Rust side', () => {
  it('a damaged connection file: the first start sends no connection key', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'settings_vault_read') return null;
      if (cmd === 'settings_import_plugin') return null;
      if (cmd === 'settings_connections') return { values: null, damaged: true };
      if (cmd === 'settings_vault_write') {
        writes.push(JSON.parse(String(args?.content)));
        return null;
      }
      throw new Error(cmd);
    }) as never;
    const { loadVaultSettings } = await import('../settings');
    const r = await loadVaultSettings(invoke);
    expect(r.connectionsDamaged).toBe(true);
    expect(writes).toHaveLength(1);
    expect('llmProvider' in writes[0]).toBe(false);
    expect('autoSyncUnitOpToc' in writes[0]).toBe(true);
  });

  it('keeps at most 64 allowed origins and refuses an address over 2048 chars', async () => {
    const { fromStored, isServiceUrl } = await import('../settings');
    const many = Array.from({ length: 80 }, (_, i) => `http://10.0.0.${i}:80`);
    expect(fromStored({ allowHttpOrigins: many }).allowHttpOrigins).toHaveLength(64);
    expect(isServiceUrl('https://a.example/' + 'x'.repeat(2100))).toBe(false);
  });
});
