/**
 * 명령 테스트용 가짜 AppHost 와 CommandContext. 파일은 fakeVault 위의 편집기를 아는 fs(앱과 같은 배선)로 간다.
 * - pick / prompt / confirm / alias 는 미리 적어 둔 답을 차례로 돌려준다(값, 또는 받은 인자로 답을 고르는 함수).
 *   답이 떨어지면 닫은 것처럼(undefined / false) 답한다. 받은 인자는 `asked` 에 남는다.
 * - notify 는 `notes` 에 남는다.
 * - `mount(path)` 는 진짜 Editor 를 그 경로에 열고 열린 노트로 삼는다(열린 노트 목록이 진짜다).
 * - `ctx.links` 는 단일 객체 `linkIndex`(비우고 `files` 로 채운 뒤 준비됨)와 가짜 보관함 위의 고침 기록이다.
 *   `cleanup()` 이 색인을 비운다.
 * - `mount` 은 앱처럼 샘플 저장소를 이 보관함과 설정에 묶고 편집기에 샘플 설정과 SampleEnv 를 준다. 저장소 판이 오르면
 *   새 설정으로 다시 그린다. `cleanup()` 이 구독을 풀고 저장소를 푼다.
 * - `opts.invoke` 는 가짜 보관함의 invoke 를 감싼다(앱의 fs 와 링크 의존성이 그것을 거친다).
 */
import type { NotifyKind, PickItem, PromptOpts } from '@labnoteo/core';
import { act } from '@testing-library/react';
import { createFakeVault, type FakeVault } from '../../__tests__/fakeVault';
import { parseRaw } from '../../editor/documentIo';
import { TauriLabnoteFs } from '../../fs/tauriLabnoteFs';
import { createJournalStore } from '../../links/journal';
import { linkIndex } from '../../links/linkIndex';
import type { CommandContext } from '../commands/context';
import { editorAwareFs } from '../editorAwareFs';
import { coreT } from '../i18n';
import type { AliasOpts, AppHost } from '../host/createAppHost';
import { activeEditTarget, openNote } from '../openNotes';
import { fromPluginData, type AppSettings } from '../settings';
import { editorConfigFrom } from '../../samples/editorConfig';
import { createSampleEnv } from '../../samples/env';
import { samples } from '../../samples/sampleStore';
import { mountEditor } from './editorHarness';

type Answer<A extends unknown[], R> = R | ((...args: A) => R);

export interface Asked {
  pick: Array<{ items: PickItem<unknown>[]; opts?: { title?: string; placeholder?: string; selected?: unknown } }>;
  prompt: PromptOpts[];
  confirm: Array<{ message: string; opts?: { confirmLabel?: string } }>;
  alias: AliasOpts[];
}

export interface TestHost {
  vault: FakeVault;
  host: AppHost;
  ctx: CommandContext;
  notes: Array<{ kind: NotifyKind; message: string }>;
  asked: Asked;
  opened: string[];
  /** ctx.showPanel 으로 고른 사이드바 탭, 차례대로. */
  panels: Array<Parameters<CommandContext['showPanel']>[0]>;
  refreshes: () => number;
  answer: {
    /** 고를 값(문자열 등), 또는 받은 항목과 옵션으로 값을 고르는 함수. */
    pick(...a: Array<string | undefined | ((items: PickItem<unknown>[], opts: Asked['pick'][number]['opts']) => unknown)>): void;
    prompt(...a: Array<Answer<[PromptOpts], string | undefined>>): void;
    confirm(...a: Array<Answer<[string], boolean>>): void;
    alias(...a: Array<Answer<[AliasOpts], string | undefined>>): void;
  };
  /** "이 노트"(편집기에 열린 노트)를 바꾼다. 편집기는 열지 않는다. */
  setActive(path: string | undefined): void;
  /** 그 경로에 진짜 편집기를 열고, 읽기를 마칠 때까지 기다린다. */
  mount(path: string): Promise<ReturnType<typeof mountEditor>>;
  /** 열어 둔 편집기를 모두 내린다. */
  cleanup(): void;
}

type InvokeFn = FakeVault['invoke'];

export function createTestHost(
  files: Record<string, string> = {},
  settings: Partial<AppSettings> = {},
  opts: { invoke?: (base: InvokeFn) => InvokeFn } = {},
): TestHost {
  const vault = createFakeVault(files);
  const invoke = opts.invoke?.(vault.invoke) ?? vault.invoke;
  const fs = editorAwareFs(new TauriLabnoteFs(invoke));
  linkIndex.clear();
  linkIndex.setFiles(Object.keys(files));
  for (const [p, text] of Object.entries(files)) if (p.endsWith('.md')) linkIndex.setNote(p, parseRaw(p, text).text);
  linkIndex.markReady();
  const notes: TestHost['notes'] = [];
  const asked: Asked = { pick: [], prompt: [], confirm: [], alias: [] };
  const opened: string[] = [];
  const panels: TestHost['panels'] = [];
  const queues = { pick: [] as unknown[], prompt: [] as unknown[], confirm: [] as unknown[], alias: [] as unknown[] };
  const next = <R>(q: unknown[], fallback: R, ...args: unknown[]): R => {
    if (q.length === 0) return fallback;
    const a = q.shift();
    return (typeof a === 'function' ? (a as (...x: unknown[]) => R)(...args) : a) as R;
  };
  let active: string | undefined;
  let refreshes = 0;
  const mounted: Array<ReturnType<typeof mountEditor>> = [];
  const offs: Array<() => void> = [];
  let current: AppSettings = { ...fromPluginData(undefined), ...settings };

  const openFile = async (path: string) => {
    opened.push(path);
    active = path;
  };

  const host: AppHost = {
    fs,
    pick: async <T>(items: PickItem<T>[], opts?: { title?: string; placeholder?: string; selected?: T }) => {
      asked.pick.push({ items: items as PickItem<unknown>[], opts });
      return next<T | undefined>(queues.pick, undefined, items, opts);
    },
    pickMany: async () => [],
    prompt: async (opts) => {
      asked.prompt.push(opts);
      return next<string | undefined>(queues.prompt, undefined, opts);
    },
    confirm: async (message, opts) => {
      asked.confirm.push({ message, opts });
      return next<boolean>(queues.confirm, false, message);
    },
    alias: async (opts) => {
      asked.alias.push(opts);
      return next<string | undefined>(queues.alias, undefined, opts);
    },
    notify: (kind, message) => void notes.push({ kind, message }),
    editTarget: () => activeEditTarget(active),
    openFile,
    t: coreT, // 앱 호스트와 같은 번역기: 부를 때의 언어
  };

  const ctx: CommandContext = {
    host,
    vaultRoot: 'C:/fake-vault',
    get settings() {
      return current;
    },
    updateSettings(p) {
      current = { ...current, ...p };
    },
    activePath: () => active,
    activeView: () => {
      const h = active ? openNote(active) : undefined;
      return h && !h.busy() ? h.view() : undefined;
    },
    openFile,
    closeActive: async () => true,
    refresh: () => void refreshes++,
    showPanel: (panel) => void panels.push(panel),
    links: {
      index: linkIndex,
      journal: createJournalStore(invoke),
      images: () => invoke<string[]>('vault_list_images', {}),
      search: (q, limit) => invoke<{ hits: { path: string }[]; truncated: boolean }>('search', { query: q, limit }),
    },
  };

  return {
    vault,
    host,
    ctx,
    notes,
    asked,
    opened,
    panels,
    refreshes: () => refreshes,
    answer: {
      pick: (...a) => void queues.pick.push(...a),
      prompt: (...a) => void queues.prompt.push(...a),
      confirm: (...a) => void queues.confirm.push(...a),
      alias: (...a) => void queues.alias.push(...a),
    },
    setActive: (path) => void (active = path),
    async mount(path) {
      samples.configure(host.fs, current);
      const m = mountEditor(vault, path, { samples: editorConfigFrom(samples, current), sampleEnv: () => createSampleEnv(ctx) });
      mounted.push(m);
      offs.push(samples.subscribe(() => m.setSamples(editorConfigFrom(samples, current))));
      await m.loaded();
      active = path;
      return m;
    },
    cleanup() {
      for (const off of offs.splice(0)) off();
      for (const m of mounted.splice(0)) act(() => m.unmount());
      samples.unbind(host.fs);
      linkIndex.clear();
    },
  };
}
