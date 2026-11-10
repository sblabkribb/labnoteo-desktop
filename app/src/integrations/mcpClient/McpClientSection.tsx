import { useEffect, useId, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { isMcpServerUrl, isServiceUrl } from '../../labnote/settings';
import type { IntegrationDeps } from '../IntegrationSettingsDialog';
import {
  isSecretLookingUrl,
  mcpClientConnect,
  mcpClientForget,
  mcpClientSecretClear,
  mcpClientSecretSet,
  mcpClientSecretStatus,
  mcpClientToolsCached,
  newServerId,
  toNetError,
  type InvokeFn,
} from '../netIpc';
import { AllowHttpBox, cleartextOrigin, UrlField } from '../UrlField';
import { McpKeyField } from './McpKeyField';
import { MCP_PRESETS, type McpPresetDef } from './presets';
import type { McpAuth, McpSecretFlag, McpServerInfo, McpServerSetting } from './types';

/** 이 묶음이 Rust 에 바라는 것. 토큰은 `secretSet` 으로 나가기만 하고 돌아오지 않는다. 주소는 넘기지 않는다(id 로만). */
export interface McpClientDeps {
  secretSet(id: string, value: string): Promise<void>;
  secretClear(id: string): Promise<void>;
  secretStatus(): Promise<Record<string, McpSecretFlag>>;
  connect(id: string): Promise<McpServerInfo>;
  forget(id: string): Promise<void>;
  toolsCached(): Promise<Record<string, McpServerInfo>>;
}

export function mcpClientDepsFor(invoke: InvokeFn = tauriInvoke): McpClientDeps {
  return {
    secretSet: (id, value) => mcpClientSecretSet(id, value, invoke),
    secretClear: (id) => mcpClientSecretClear(id, invoke),
    secretStatus: () => mcpClientSecretStatus(invoke),
    connect: (id) => mcpClientConnect(id, invoke),
    forget: (id) => mcpClientForget(id, invoke),
    toolsCached: () => mcpClientToolsCached(invoke),
  };
}

/** 서버가 보낸 글의 최대 길이(spec §6.1, §4.3). */
const CAP_NAME = 80;
const CAP_VERSION = 40;
const CAP_DESCRIPTION = 1000;

const cap = (s: string | undefined, n: number): string => {
  const chars = [...(s ?? '')];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
};

/** 한 줄: 화면에 그린 서버 줄 하나. 프리셋은 저장 전에도 줄이 있다(`server` 없음). */
interface Row {
  key: string;
  server?: McpServerSetting;
  preset?: McpPresetDef;
}

type Result = 'checking' | { info: McpServerInfo } | { error: string };

/** "연결 확인" 이 거절된 까닭을 §9 의 한 줄로. Rust 의 글과 `Status` 의 body 는 보이지 않는다. */
function connectErrorLine(e: unknown, auth: McpAuth): { text: string; focusToken: boolean } {
  const err = toNetError(e);
  switch (err.kind) {
    case 'mcpAuth':
      return auth === 'none' ? { text: t('mcpClient.err.needsAuth'), focusToken: false } : { text: t('mcpClient.err.auth'), focusToken: true };
    case 'keyMissing':
      return { text: t('mcpClient.err.keyMissing'), focusToken: true };
    case 'mcpModernOnly':
      return { text: t('mcpClient.err.modern'), focusToken: false };
    case 'mcpProtocol':
      // Rust 의 고정된 글로 버전 거절을 가른다(서버 글은 들어 있지 않다).
      if (err.message.includes('MCP version')) return { text: t('mcpClient.err.version'), focusToken: false };
      return { text: t('mcpClient.err.protocol'), focusToken: false };
    case 'notJson':
      return { text: t('mcpClient.err.protocol'), focusToken: false };
    case 'timeout':
      return { text: t('mcpClient.err.timeout'), focusToken: false };
    case 'redirect': {
      let origin = '?';
      try {
        if (err.location) origin = new URL(err.location).origin;
      } catch {
        // 읽을 수 없는 주소는 보이지 않는다.
      }
      return { text: t('mcpClient.err.redirect', origin), focusToken: false };
    }
    case 'offline':
    case 'tls':
      return { text: t('mcpClient.err.offline'), focusToken: false };
    case 'keychain':
      return { text: t('mcpClient.err.keychain'), focusToken: false };
    case 'status':
      return { text: t('mcpClient.err.status', err.status ?? 0), focusToken: false };
    default:
      return { text: t('integrations.testFailed'), focusToken: false };
  }
}

/** 주소 칸의 경고. 비밀처럼 보이는 주소는 되풀이하지 않는다. */
function urlProblem(raw: string, allowHttp: readonly string[]): { warning?: string; cleartext?: string } {
  const v = raw.trim();
  if (isSecretLookingUrl(v)) return { warning: t('mcpClient.err.urlSecret') };
  if (!isServiceUrl(v)) return { warning: coreT('Enter a full address starting with http:// or https://.') };
  if (isMcpServerUrl(v, allowHttp)) return {};
  const origin = cleartextOrigin(new URL(v));
  return origin ? { cleartext: origin } : { warning: coreT('Enter a full address starting with http:// or https://.') };
}

/**
 * "외부 MCP 서버" 묶음(spec §6.1). RAPID, BioModel Portal 프리셋을 맨 위에(저장 전에도), 그 밑에 저장된 다른 서버를 보인다.
 * 줄마다 이름, 주소(프리셋은 "주소 바꾸기" 뒤에서 고친다), 쓰기만 하는 토큰 칸, AI 사용 스위치, "연결 확인".
 *
 * - "연결 확인" 은 저장된 토큰만 쓴다: 친 토큰은 `mcp_client_secret_set` 으로만 나간다.
 * - 서버가 보낸 이름, 버전, 도구 글은 평문(React 이스케이프)으로, 길이를 잘라 보인다.
 * - 저장된 서버의 주소를 바꾸면 먼저 `mcp_client_forget(id)`(옛 토큰, 캐시, 세션)을 부르고 새 주소를 저장한다.
 * - `deps.mcpClient` 가 없으면 그리지 않는다.
 */
export function McpClientSection(p: {
  deps: IntegrationDeps;
  onHide(commit: () => Promise<void>): void;
  focusServer?: string;
}): JSX.Element | null {
  const { deps } = p;
  const mc = deps.mcpClient;
  const id = useId();
  const serversRef = useRef<McpServerSetting[]>(deps.value().mcpClientServers ?? []);
  const [servers, setServers] = useState(serversRef.current);
  const [flags, setFlags] = useState<Record<string, McpSecretFlag>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  /** 고치는 중인 주소(줄 key → 칸의 값). 없으면 주소를 글로 보인다. */
  const draftsRef = useRef<Record<string, string>>({});
  const [drafts, setDraftsState] = useState<Record<string, string>>({});
  const [urlNotes, setUrlNotes] = useState<Record<string, { warning?: string; cleartext?: string }>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const rows: Row[] = [
    ...MCP_PRESETS.map((preset) => ({ key: preset.preset, preset, server: servers.find((s) => s.preset === preset.preset) })),
    ...servers.filter((s) => !s.preset).map((server) => ({ key: server.id, server })),
  ];
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const setDrafts = (next: Record<string, string>) => {
    draftsRef.current = next;
    setDraftsState(next);
  };
  const setResult = (key: string, r: Result | undefined) =>
    setResults((all) => {
      const next = { ...all };
      if (r === undefined) delete next[key];
      else next[key] = r;
      return next;
    });

  const refreshFlags = async () => {
    if (!mc) return;
    try {
      setFlags(await mc.secretStatus());
    } catch {
      // 상태를 읽지 못하면 '설정 안 됨'으로 보인다. 다음에 열면 다시 읽는다.
    }
  };

  useEffect(() => {
    if (!mc) return;
    let live = true;
    mc.secretStatus().then(
      (f) => live && setFlags(f),
      () => undefined,
    );
    mc.toolsCached().then(
      (cached) => {
        if (!live) return;
        setResults((all) => {
          const next = { ...all };
          for (const s of serversRef.current) {
            const info = cached[s.id];
            const key = s.preset ?? s.id;
            if (info && next[key] === undefined) next[key] = { info };
          }
          return next;
        });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [mc]);

  useEffect(() => {
    if (!p.focusServer) return;
    const row = rowsRef.current.find((r) => r.server?.id === p.focusServer);
    if (row) inputs.current[row.key]?.focus();
  }, [p.focusServer]);

  const commitServers = async (next: McpServerSetting[]) => {
    serversRef.current = next;
    setServers(next);
    await deps.commit({ mcpClientServers: next });
  };

  const allowHttp = () => deps.value().allowHttpOrigins;

  /** 고치는 중인 주소를 저장한다. 올바르지 않으면 저장하지 않고 false. 저장된 서버면 먼저 잊는다(옛 토큰, 캐시, 세션). */
  const commitUrl = async (key: string): Promise<boolean> => {
    const raw = draftsRef.current[key];
    if (raw === undefined) return true;
    const problem = urlProblem(raw, allowHttp());
    setUrlNotes((n) => ({ ...n, [key]: problem }));
    if (problem.warning || problem.cleartext) return false;
    const url = raw.trim();
    const row = rowsRef.current.find((r) => r.key === key);
    const server = row?.server ? serversRef.current.find((s) => s.id === row.server!.id) : undefined;
    if (server && server.url !== url) {
      try {
        await mc?.forget(server.id);
      } catch {
        // 잊지 못하면 주소를 바꾸지 않는다(옛 토큰이 새 주소에 묶이지 않게 Rust 가 origin 으로도 막는다).
        return false;
      }
      try {
        await commitServers(serversRef.current.map((s) => (s.id === server.id ? { ...s, url } : s)));
      } catch {
        return false;
      }
      setResult(key, undefined);
      await refreshFlags();
    }
    return true;
  };

  const toggleAllow = async (key: string, origin: string) => {
    const list = allowHttp();
    const next = list.includes(origin) ? list.filter((o) => o !== origin) : [...list, origin];
    try {
      await deps.commit({ allowHttpOrigins: next });
    } catch {
      return;
    }
    const raw = draftsRef.current[key];
    if (raw !== undefined) setUrlNotes((n) => ({ ...n, [key]: urlProblem(raw, next) }));
  };

  // 설정 창이 닫힐 때 고치는 중인 주소를 저장한다(칸이 사라질 때는 blur 가 오지 않는다).
  const hideCommit = useRef(async () => {
    for (const key of Object.keys(draftsRef.current)) await commitUrlRef.current(key);
  });
  const commitUrlRef = useRef(commitUrl);
  commitUrlRef.current = commitUrl;
  const onHide = p.onHide;
  useEffect(() => {
    onHide(hideCommit.current);
  }, [onHide]);

  if (!mc) return null;

  /** 토큰 저장. 프리셋을 처음 저장하면 서버 항목을 먼저 만든다(Rust 는 저장된 설정에서 id 로 주소를 찾는다). */
  const saveToken = async (row: Row, value: string) => {
    let server = row.server;
    if (draftsRef.current[row.key] !== undefined && server) {
      if (!(await commitUrl(row.key))) throw new Error('url not saved');
      server = serversRef.current.find((s) => s.id === server!.id);
    }
    if (!server) {
      const preset = row.preset!;
      const draft = draftsRef.current[row.key];
      const url = draft === undefined ? preset.url : draft.trim();
      if (draft !== undefined) {
        const problem = urlProblem(draft, allowHttp());
        setUrlNotes((n) => ({ ...n, [row.key]: problem }));
        if (problem.warning || problem.cleartext) throw new Error('url not valid');
      }
      server = { id: newServerId(), name: preset.name, url, auth: 'bearer', preset: preset.preset, enabled: true, tools: {} };
      await commitServers([...serversRef.current, server]);
    }
    await mc.secretSet(server.id, value);
  };

  const onTokenSaved = (row: Row) => {
    setResult(row.key, undefined);
    void refreshFlags();
  };

  const clearToken = async (row: Row) => {
    if (!row.server) return;
    await mc.secretClear(row.server.id);
  };

  const connect = async (row: Row) => {
    const server = row.server;
    if (!server) {
      setResult(row.key, { error: t('mcpClient.err.keyMissing') });
      inputs.current[row.key]?.focus();
      return;
    }
    setResult(row.key, 'checking');
    try {
      const info = await mc.connect(server.id);
      setResult(row.key, { info });
    } catch (e) {
      const line = connectErrorLine(e, server.auth);
      setResult(row.key, { error: line.text });
      if (line.focusToken) inputs.current[row.key]?.focus();
    }
  };

  const toggleEnabled = async (server: McpServerSetting) => {
    try {
      await commitServers(serversRef.current.map((s) => (s.id === server.id ? { ...s, enabled: !s.enabled } : s)));
    } catch {
      // 앱의 설정 저장이 실패를 따로 알린다.
    }
  };

  const startEditUrl = (row: Row) => {
    setDrafts({ ...draftsRef.current, [row.key]: row.server?.url ?? row.preset?.url ?? '' });
  };

  const renderResult = (row: Row) => {
    const r = results[row.key];
    if (!r) return null;
    if (r === 'checking') {
      return (
        <p role="status" className="prompt-hint">
          {coreT('Checking…')}
        </p>
      );
    }
    if ('error' in r) {
      return (
        <p role="alert" className="prompt-hint warn">
          {r.error}
        </p>
      );
    }
    const { info } = r;
    return (
      <div className="mcp-client-info">
        <p role="status" className="prompt-hint">
          {t('mcpClient.connected', cap(info.name, CAP_NAME), cap(info.version, CAP_VERSION), cap(info.protocolVersion, CAP_VERSION), info.tools.length)}
        </p>
        {info.tools.length === 0 ? (
          <p className="prompt-hint">{t('mcpClient.noTools')}</p>
        ) : (
          <ul className="mcp-client-tools">
            {info.tools.map((tool) => (
              <li key={tool.name}>
                <span className="mcp-client-tool-name">{cap(tool.title || tool.name, CAP_NAME)}</span>
                {tool.description ? <span className="prompt-hint">{cap(tool.description, CAP_DESCRIPTION)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderRow = (row: Row) => {
    const server = row.server;
    const name = server?.name ?? row.preset?.name ?? '';
    const url = server?.url ?? row.preset?.url ?? '';
    const auth: McpAuth = server?.auth ?? 'bearer';
    const nameId = `${id}-${row.key}-name`;
    const draft = drafts[row.key];
    const note = urlNotes[row.key] ?? {};
    return (
      <div key={row.key} role="group" aria-labelledby={nameId} className="integration-group mcp-client-server">
        <div className="mcp-client-head">
          <span id={nameId} className="mcp-client-name">
            {name}
          </span>
          {server ? (
            <label className="prompt-question switch-label">
              <input type="checkbox" role="switch" className="switch" checked={server.enabled} onChange={() => void toggleEnabled(server)} />{' '}
              {t('mcpClient.enabled')}
            </label>
          ) : null}
        </div>
        {draft === undefined ? (
          <div className="integration-field mcp-client-url">
            <span className="mcp-client-url-text">{url}</span>
            <button type="button" className="mcp-client-link" onClick={() => startEditUrl(row)}>
              {t('mcpClient.changeUrl')}
            </button>
          </div>
        ) : (
          <UrlField
            label={t('mcpClient.url')}
            placeholder={row.preset?.url}
            value={draft}
            onChange={(v) => {
              setDrafts({ ...draftsRef.current, [row.key]: v });
              setUrlNotes((n) => ({ ...n, [row.key]: {} }));
            }}
            onCommit={() => void commitUrl(row.key)}
            warnings={[
              ...(note.warning ? [note.warning] : []),
              ...(note.cleartext ? [coreT('This address is not encrypted, so the API key is sent in the clear.')] : []),
            ]}
          >
            {note.cleartext ? (
              <AllowHttpBox checked={allowHttp().includes(note.cleartext)} onToggle={() => void toggleAllow(row.key, note.cleartext!)} />
            ) : null}
          </UrlField>
        )}
        {auth === 'bearer' ? (
          <McpKeyField
            label={t('mcpClient.token')}
            hint={row.preset ? t(row.preset.tokenHintKey) : undefined}
            isSet={server ? flags[server.id]?.set === true : false}
            save={(v) => saveToken(row, v)}
            clear={() => clearToken(row)}
            inputRef={(el) => {
              inputs.current[row.key] = el;
            }}
            onSaved={() => onTokenSaved(row)}
          />
        ) : null}
        <div className="integration-test">
          <button type="button" disabled={results[row.key] === 'checking'} onClick={() => void connect(row)}>
            {t('mcpClient.connect')}
          </button>
        </div>
        {renderResult(row)}
      </div>
    );
  };

  return (
    <section className="integration-section mcp-client">
      <h3>{t('mcpClient.title')}</h3>
      <p className="prompt-hint">{t('mcpClient.help')}</p>
      {rows.map(renderRow)}
    </section>
  );
}
