// @vitest-environment jsdom
/**
 * SP6 전체의 공존·회귀 그물(Task 42). 네트워크는 Rust 만 한다: CSP 의 connect-src 는 로컬 그대로이고, 새 코드는
 * fetch/XMLHttpRequest 도 인라인 스타일도 쓰지 않는다. 네트워크 커맨드가 모두 오프라인으로 실패해도 `@` 완성, 샘플 대장,
 * 노트 편집은 그대로 돈다. 키 값은 설정 파일에도 보관함 파일에도 쓰이지 않는다. 모든 NetError kind 는 세 연동 모두에서
 * 사용자 문장이 되고, Rust 의 원래 글('raw-rust-text')은 나오지 않는다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../../i18n/lang';
import { coreT } from '../../labnote/i18n';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { PartbankFeature } from '../../labnote/port/partbankFeature';
import { toPartbankError } from '../../labnote/port/partbankClient';
import { describeLlmError } from '../../labnote/port/llmError';
import { loadCatalogSamples } from '../../labnote/port/sampleScope';
import { fromStored, saveVaultSettings, type AppSettings } from '../../labnote/settings';
import { bfwErrorText } from '../../bfworkflow/bfwApp';
import { partbankSource } from '../../partbank/partbankSource';
import { setPartbankCatalogStore, type PartbankCatalogStore } from '../../partbank/catalogOverlay';
import { createSampleEnv } from '../../samples/env';
import { clearSampleSourceCaches, localActionsSource, registrySource, sampleQueryAt, type SampleRow } from '../../samples/sources';
import { GLOBAL, NOTE, SAMPLE_VAULT } from '../../samples/__tests__/fixtures';
import { samples } from '../../samples/sampleStore';
import { IntegrationSettingsPage, integrationDepsFor } from '../IntegrationSettingsDialog';
import { NET_ERROR_KINDS, type InvokeFn } from '../netIpc';
import { netError, secretStatusOf } from './fakeNet';

// ── 소스 훑기 ─────────────────────────────────────────────────────

/** SP6 가 만든 앱 폴더와, 옮겨 온 SP6 포트 파일(계획의 Port files 목록). */
const NEW_FOLDERS = ['src/integrations', 'src/partbank', 'src/ai', 'src/bfworkflow'];
const PORT_DIR = 'src/labnote/port';
const SP6_PORTS = [
  'partbankClient.ts',
  'partbankFeature.ts',
  'partbankSearch.ts',
  'partbankRegister.ts',
  'partbankSuggest.ts',
  'partbankCatalog.ts',
  'partbankLocation.ts',
  'partbankActions.ts',
  'partbankUri.ts',
  'labnoteOpenUri.ts',
  'partbankUsageSync.ts',
  'llmProvider.ts',
  'llmError.ts',
  'llmAgent.ts',
  'approvalMessage.ts',
  'aiAnswerDialog.tsx',
  'aiCommon.ts',
  'aiDraftMethod.ts',
  'aiSummaries.ts',
  'aiExtractSamples.ts',
  'aiAskAgent.ts',
];

/** 테스트가 아닌 .ts/.tsx 소스. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

function newSources(): Array<{ f: string; code: string }> {
  const files = [...NEW_FOLDERS.flatMap(sources), ...SP6_PORTS.map((n) => join(PORT_DIR, n))];
  return files.map((f) => ({ f, code: readFileSync(f, 'utf-8') }));
}

/**
 * 전역 fetch 나 XMLHttpRequest 를 쓰는 곳. 계획의 정규식(단어 경계 + "fetch(")은 provider.fetch(source) 같은 메서드
 * (partbankLocation 의 보관 위치 공급자)까지 잡으므로, 구문 트리에서 전역을 가리키는 것만 찾는다:
 * `fetch(...)`, `window|globalThis|self.fetch`, 그리고 이름 `XMLHttpRequest` 어디서든.
 */
function networkUses(file: string, code: string): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'XMLHttpRequest') found.push(`${at(n)} XMLHttpRequest`);
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e) && e.text === 'fetch') found.push(`${at(n)} fetch(`);
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'fetch' &&
      ts.isIdentifier(n.expression) &&
      ['window', 'globalThis', 'self'].includes(n.expression.text)
    ) {
      found.push(`${at(n)} ${n.expression.text}.fetch`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('sources', () => {
  it('the CSP is unchanged: connect-src stays local', () => {
    const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf-8'));
    expect(conf.app.security.csp).toContain("connect-src 'self' ipc: http://ipc.localhost;");
    expect(conf.app.security.csp).not.toMatch(/connect-src[^;]*https?:\/\/(?!ipc\.localhost)/);
  });

  it('no new source sets inline styles', () => {
    const files = newSources();
    expect(files.length).toBeGreaterThan(SP6_PORTS.length);
    const hits = files.filter(({ code }) => /style=\{|\.style\./.test(code)).map(({ f }) => f);
    expect(hits).toEqual([]);
  });

  it('no source calls fetch or XMLHttpRequest', () => {
    const hits = newSources().flatMap(({ f, code }) => networkUses(f, code));
    expect(hits).toEqual([]);
    // 검사기 자신이 잡아야 할 것은 잡고, 메서드 이름 fetch 는 놓아준다
    expect(networkUses('x.ts', 'await fetch("https://a");')).toHaveLength(1);
    expect(networkUses('x.ts', 'globalThis.fetch(u); new XMLHttpRequest();')).toHaveLength(2);
    expect(networkUses('x.ts', 'class P { async fetch(s: string) { return s; } } await p.fetch(s);')).toEqual([]);
  });
});

// ── 오프라인 ───────────────────────────────────────────────────────

const DNA_CATALOG = JSON.stringify({
  'dna-77': {
    type: 'DNA',
    alias: 'pUC ori',
    descriptions: ['origin'],
    sources: [],
    source: { system: 'partbank', origin: 'https://partbank.kbiofoundry.kr', type: 'plasmids', id: '0123456789abcdef01234567' },
  },
});

function memoryStore(files: Record<string, string>): PartbankCatalogStore {
  return {
    names: async () => Object.keys(files),
    read: async (n) => files[n],
    write: async () => {
      throw new Error('read-only in this test');
    },
    subscribe: () => () => undefined,
  };
}

const NETWORK = /^(partbank_(request|probe)|llm_|bfw_)/;

let hosts: TestHost[] = [];
beforeEach(() => setLang('en'));
afterEach(() => {
  cleanup();
  for (const th of hosts) th.cleanup();
  hosts = [];
  setPartbankCatalogStore(undefined);
  clearSampleSourceCaches();
  samples.resetForTest();
});

describe('offline', () => {
  it('with every network command failing offline, @ completion, the sample store and note editing still work', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const networkCalls: string[] = [];
    let invoke!: InvokeFn;
    const th = createTestHost(SAMPLE_VAULT, { partbankWebUrl: 'https://partbank.kbiofoundry.kr', partbankDefaultConnection: 'web' }, {
      invoke: (base) =>
        (invoke = (async (cmd: string, args?: Record<string, unknown>) => {
          if (NETWORK.test(cmd)) {
            networkCalls.push(cmd);
            throw { kind: 'offline', message: 'raw-rust-text' };
          }
          if (cmd === 'secret_status') return secretStatusOf({ partbankWeb: true, llmOpenai: true, bfwServer: true });
          return base(cmd, args);
        }) as InvokeFn),
    });
    hosts.push(th);
    const feature = new PartbankFeature({ settings: () => th.ctx.settings, host: th.host, invoke });
    await feature.refresh();
    const env = createSampleEnv(th.ctx, { catalogs: memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }) });

    // `@DNA;` 의 줄: 대장 샘플, 카탈로그 검색, 그리고 partbank 줄(줄을 만들 때는 네트워크를 쓰지 않는다)
    const q = sampleQueryAt('@DNA;', NOTE, env.types())!;
    const rows: SampleRow[] = [
      ...(await registrySource.rows(q, env)),
      ...(await localActionsSource.rows(q, env)),
      ...(await partbankSource(() => feature).rows(q, env)),
    ];
    const kinds = rows.map((r) => (r.kind === 'action' ? r.source : r.entry.id));
    expect(kinds).toEqual(expect.arrayContaining(['DNA-1', 'catalog', 'partbank']));
    // Search catalog 은 앱 데이터의 내려받은 카탈로그를 읽는다
    const found = await loadCatalogSamples(env, GLOBAL, 'DNA');
    expect(found['dna-77']?.alias).toBe('pUC ori');

    // partbank 검색 자체는 오프라인 문장 하나로 끝난다
    const client = feature.defaultClient()!;
    const err = await client.searchGlobal('pUC', ['vector']).then(
      () => undefined,
      (e: unknown) => e,
    );
    const said = feature.describeError(err, client);
    expect(said).toBe(coreT('Could not reach the partbank server at {0}.', 'https://partbank.kbiofoundry.kr'));

    // 노트 편집: 쓰기는 보관함으로 그대로 간다
    await env.processNote(NOTE, (text) => `${text}\nOffline edit.\n`);
    expect(await th.host.fs.read(NOTE)).toContain('Offline edit.');

    expect(networkCalls).toEqual(['partbank_request']);
    expect(th.notes.map((n) => n.message).join('\n')).not.toContain('raw-rust-text');
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

// ── 키 누출 ────────────────────────────────────────────────────────

describe('keys', () => {
  it('no settings file or vault file ever contains a key value', async () => {
    const secrets: Array<Record<string, unknown>> = [];
    let set = secretStatusOf({});
    let invoke!: InvokeFn;
    const th = createTestHost(SAMPLE_VAULT, {}, {
      invoke: (base) =>
        (invoke = (async (cmd: string, args: Record<string, unknown> = {}) => {
          if (cmd === 'secret_status') return set;
          if (cmd === 'secret_set') {
            secrets.push(args);
            set = secretStatusOf({ [String(args.slot)]: true });
            return null;
          }
          if (cmd === 'secret_clear') return null;
          return base(cmd, args);
        }) as InvokeFn),
    });
    hosts.push(th);
    // 앱처럼 바뀐 설정을 settings_vault_write 로 저장한다
    let settings: AppSettings = fromStored({});
    const ctx = {
      ...th.ctx,
      get settings() {
        return settings;
      },
      async updateSettings(p: Partial<AppSettings>) {
        settings = { ...settings, ...p };
        await saveVaultSettings(settings, invoke);
      },
    } as typeof th.ctx;
    render(createElement(IntegrationSettingsPage, { deps: integrationDepsFor(ctx, invoke), onLeave: async () => {} }));

    const url = (await screen.findByLabelText('partbank server address')) as HTMLInputElement;
    const key = screen.getByLabelText('partbank server API key') as HTMLInputElement;
    await userEvent.clear(url);
    await userEvent.type(url, 'https://pb.lab.kr');
    await userEvent.type(key, 'pbk_leaky_secret');
    await userEvent.click(within(key.closest('.integration-key') as HTMLElement).getByText('Save key'));
    await waitFor(() => expect(secrets).toHaveLength(1));
    expect(secrets[0]).toEqual({ slot: 'partbankWeb', value: 'pbk_leaky_secret' });

    // 설정은 저장됐다(주소는 바뀌었다), 키는 어느 쓰기에도 없다
    const writes = th.vault.log;
    const settingsWrites = writes.filter((l) => l.cmd === 'settings_vault_write');
    expect(settingsWrites.length).toBeGreaterThan(0);
    expect(settingsWrites.some((l) => String(l.args.content).includes('https://pb.lab.kr'))).toBe(true);
    for (const l of writes) expect(JSON.stringify(l.args)).not.toContain('pbk_');
    expect(JSON.stringify(th.vault.files())).not.toContain('pbk_');
    expect(String(th.vault.settings)).not.toContain('pbk_');
    expect(JSON.stringify(settings)).not.toContain('pbk_');
    expect(document.body.textContent).not.toContain('pbk_');
  });
});

// ── 오류 문장 ───────────────────────────────────────────────────────

describe('errors', () => {
  it('every NetError kind has a user sentence in each integration', () => {
    // toPartbankError 는 앱 버그(badInput 등)를 kind 만 경고로 남긴다: 그 경고에도 Rust 의 글은 없다
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const feature = new PartbankFeature({
      settings: () => ({ ...fromStored({}), partbankWebUrl: 'https://partbank.kbiofoundry.kr' }),
      host: { notify: () => undefined, t: coreT },
      invoke: (async () => undefined) as InvokeFn,
    });
    const llmSettings: AppSettings = { ...fromStored({}), llmProvider: 'openai', llmEndpointOpenai: 'https://api.openai.com' };
    const kinds = NET_ERROR_KINDS.filter((k) => k !== 'cancelled');
    expect(kinds.length).toBe(NET_ERROR_KINDS.length - 1);
    for (const k of kinds) {
      const extras = k === 'status' ? [{ status: 401 }, { status: 404 }, { status: 500 }, {}] : [{}];
      for (const extra of extras) {
        const e = netError(k, extra);
        const texts = {
          partbank: feature.describeError(toPartbankError(e)),
          partbankNet: feature.describeError(e),
          llm: describeLlmError(e, llmSettings, coreT),
          bfw: bfwErrorText(e, { connection: 'server', url: 'https://workflow.kbiofoundry.kr', scope: 'read' }),
          bfwDesktop: bfwErrorText(e, { connection: 'desktop', url: 'http://127.0.0.1:1234' }),
        };
        for (const [where, text] of Object.entries(texts)) {
          const label = `${k} ${JSON.stringify(extra)} ${where}`;
          expect(text.trim(), label).not.toBe('');
          expect(text, label).not.toContain('raw-rust-text');
        }
      }
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('raw-rust-text');
    warn.mockRestore();
  });
});
