import { useEffect, useId, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../../i18n/t';
import type { InvokeFn } from '../../integrations/netIpc';
import { coreT, overrideOr } from '../i18n';
import { isMcpPort } from '../settings';
import { MCP_CLIENTS, clientSnippet, mcpErrorOf, startMcpServer, stopMcpServer, type Notify } from './commands';
import { mcpStatus, mcpTokenCopy, mcpTokenRegenerate, mcpTokenStatus, type McpClientId, type TokenStatus } from './mcpIpc';

/** 재발급을 확인하는 두 번째 누름을 기다리는 시간(플러그인 `settingsTab.ts:31` REGENERATE_CONFIRM_MS). */
const REGENERATE_CONFIRM_MS = 5000;

export interface McpSectionProps {
  /** 저장된 `mcpEnabled` 와 `mcpPort`. */
  enabled: boolean;
  port: number;
  /** 설정을 저장한다(연동 설정 대화상자의 저장 길). */
  commit(patch: { mcpEnabled?: boolean; mcpPort?: number }): Promise<void>;
  notify: Notify;
  invoke?: InvokeFn;
}

/**
 * 연동 설정의 MCP 묶음(플러그인 `settingsTab.ts:485-565`, 같은 줄 순서): 스위치, 포트, 듣는 주소, 토큰, 그리고
 * "클라이언트 연결"(사용자 결정 2026-11-09).
 * - 토큰 값은 이 화면에 오지 않는다: 번호(`epoch`)만 보이고, 복사는 Rust 가 클립보드에 직접 한다(60초 뒤 지움).
 * - 클라이언트 설정 글은 토큰 자리에 `<token>` 을 보이고, 복사할 때만 Rust 가 진짜 토큰으로 채운다.
 * - 재발급은 대화상자 대신 5초 안의 두 번째 누름으로 확인한다(플러그인 #107).
 */
export function McpSection(props: McpSectionProps) {
  const { commit, notify } = props;
  const invoke = props.invoke ?? (tauriInvoke as InvokeFn);
  const id = useId();
  const [enabled, setEnabled] = useState(props.enabled);
  const [port, setPort] = useState(props.port);
  const portRef = useRef(props.port);
  const [draft, setDraftState] = useState(String(props.port));
  const draftRef = useRef(String(props.port));
  const [portWarn, setPortWarn] = useState(false);
  const [running, setRunningState] = useState(false);
  const runningRef = useRef(false);
  const [token, setToken] = useState<TokenStatus>();
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout>>();
  const busy = useRef(false);

  const setRunning = (v: boolean) => {
    runningRef.current = v;
    setRunningState(v);
  };
  const setDraft = (v: string) => {
    draftRef.current = v;
    setDraftState(v);
  };
  const refreshToken = () =>
    mcpTokenStatus(invoke).then(
      (s) => setToken(s),
      () => undefined,
    );

  const disarm = () => {
    if (armTimer.current !== undefined) clearTimeout(armTimer.current);
    armTimer.current = undefined;
    setArmed(false);
  };

  /** 칸의 포트를 저장한다. 서버가 돌고 있으면 새 포트로 다시 시작한다. 올바르지 않으면 저장하지 않는다. */
  const commitPort = async () => {
    const raw = draftRef.current.trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !isMcpPort(n)) {
      setPortWarn(true);
      return;
    }
    setPortWarn(false);
    if (raw !== draftRef.current) setDraft(raw);
    if (n === portRef.current) return;
    portRef.current = n;
    setPort(n);
    await commit({ mcpPort: n });
    if (runningRef.current) setRunning(await startMcpServer(n, notify, invoke));
  };
  const commitPortRef = useRef(commitPort);
  commitPortRef.current = commitPort;

  useEffect(() => {
    let live = true;
    mcpStatus(invoke).then(
      (s) => live && setRunning(s.running),
      () => undefined,
    );
    mcpTokenStatus(invoke).then(
      (s) => live && setToken(s),
      () => undefined,
    );
    return () => {
      live = false;
      if (armTimer.current !== undefined) clearTimeout(armTimer.current);
      // 칸을 떠나지 않고 닫았을 때(Esc): 올바른 새 포트면 저장한다.
      if (draftRef.current.trim() !== String(portRef.current)) void commitPortRef.current();
    };
    // 한 번만: invoke 는 이 화면 동안 같다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onToggle = async (on: boolean) => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (on) {
        if (!(await startMcpServer(portRef.current, notify, invoke))) return;
        setEnabled(true);
        setRunning(true);
        await commit({ mcpEnabled: true });
      } else {
        await stopMcpServer(invoke).catch((e: unknown) => notify('error', coreT('MCP server error: {0}', mcpErrorOf(e).message)));
        setEnabled(false);
        setRunning(false);
        await commit({ mcpEnabled: false });
      }
    } finally {
      busy.current = false;
    }
  };

  const onCopy = async () => {
    try {
      await mcpTokenCopy(invoke);
    } catch {
      notify('error', t('mcp.copyFailed'));
      return;
    }
    notify('info', t('mcp.tokenCopied'));
    void refreshToken();
  };

  const onRegenerate = async () => {
    if (armTimer.current === undefined) {
      setArmed(true);
      armTimer.current = setTimeout(disarm, REGENERATE_CONFIRM_MS);
      return;
    }
    disarm();
    let status: TokenStatus;
    try {
      status = await mcpTokenRegenerate(invoke);
    } catch (e) {
      notify('error', coreT('MCP server error: {0}', mcpErrorOf(e).message));
      return;
    }
    setToken(status);
    notify('info', coreT('New MCP token issued. The old token no longer works.'));
    try {
      await mcpTokenCopy(invoke);
    } catch {
      notify('warn', coreT('The new token could not be copied. Use "Copy token".'));
      return;
    }
    notify('info', t('mcp.tokenCopied'));
  };

  const onCopyClient = async (client: McpClientId, name: string) => {
    try {
      await mcpTokenCopy(invoke, { client, port: portRef.current });
    } catch {
      notify('error', t('mcp.copyFailed'));
      return;
    }
    notify('info', t('mcp.connect.copied', name));
    void refreshToken();
  };

  return (
    <section className="integration-section mcp-section">
      <h5>{coreT('MCP server')}</h5>
      <div className="integration-field">
        <label className="prompt-question switch-label">
          <input type="checkbox" role="switch" className="switch" checked={enabled} onChange={(e) => void onToggle(e.target.checked)} />{' '}
          {coreT('Enable MCP server')}
        </label>
        <p className="prompt-hint">{overrideOr('mcp.enableDesc')}</p>
      </div>
      <div className="integration-field">
        <label className="prompt-question" htmlFor={`${id}-port`}>
          {t('mcp.port')}
        </label>
        <input
          id={`${id}-port`}
          className="mcp-port"
          type="number"
          inputMode="numeric"
          min={1024}
          max={65535}
          step={1}
          autoComplete="off"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setPortWarn(false);
          }}
          onBlur={() => void commitPort()}
        />
        {portWarn ? <p className="prompt-hint warn">{t('mcp.portInvalid')}</p> : null}
        {running ? (
          <p role="status" className="prompt-hint">
            {t('mcp.listening', port)}
          </p>
        ) : null}
      </div>
      <div className="integration-field">
        <span className="prompt-question">{coreT('MCP token')}</span>
        <p className="prompt-hint">{overrideOr('mcp.tokenDesc')}</p>
        {token ? <p className="mcp-token-state">{token.set ? t('mcp.tokenIssued', token.epoch) : t('mcp.tokenNone')}</p> : null}
        <div className="mcp-actions">
          <button type="button" onClick={() => void onCopy()}>
            {coreT('Copy token')}
          </button>
          <button type="button" className={armed ? 'danger' : undefined} onClick={() => void onRegenerate()}>
            {armed ? coreT('Click again to regenerate') : coreT('Regenerate token')}
          </button>
        </div>
      </div>
      <div className="integration-field mcp-connect">
        <span className="prompt-question">{t('mcp.connect.heading')}</span>
        <p className="prompt-hint">{t('mcp.connect.hint')}</p>
        {MCP_CLIENTS.map((c) => (
          <div className="mcp-client" key={c.id}>
            <div className="mcp-client-head">
              <span className="mcp-client-name">{c.name}</span>
              <button type="button" onClick={() => void onCopyClient(c.id, c.name)}>
                {t('mcp.connect.copy', c.name)}
              </button>
            </div>
            <pre className="mcp-snippet">
              <code>{clientSnippet(c.id, port)}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}
