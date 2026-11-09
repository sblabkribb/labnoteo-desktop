import { useEffect, useId, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import { coreT, overrideOr } from '../labnote/i18n';
import type { CommandContext } from '../labnote/commands/context';
import { DialogFrame } from '../labnote/host/DialogFrame';
import { openDialog } from '../labnote/host/dialogStore';
import { BFW_DEFAULT_URL, fromPluginData, isOriginUrl, type AppSettings } from '../labnote/settings';
import { KeyField } from './KeyField';
import { notifySecretsChange } from './secretsEvents';
import { clearSecret, secretStatus, setSecret, type InvokeFn, type SecretStatus, type Slot } from './netIpc';
import { probeFor, runIntegrationChangeHooks, type IntegrationSettingsValue, type ProbeFn, type ProbeId } from './probes';
import { AllowHttpBox, cleartextOrigin, resolveEndpoint, UrlField } from './UrlField';

export type { IntegrationSettingsValue } from './probes';
export { notifySecretsChange, onIntegrationChange, onSecretsChange, probeFor, registerProbe } from './probes';

/** 대화상자가 쓰는 바깥 함수들. 키 값은 setSecret 으로 나가기만 하고 돌아오지 않는다. */
export interface IntegrationDeps {
  value(): IntegrationSettingsValue;
  /** 설정을 먼저 저장하고(`ctx.updateSettings`), 그다음 onIntegrationChange 고리를 (앞, 뒤) 값으로 부른다. */
  commit(patch: Partial<IntegrationSettingsValue>): Promise<void>;
  status(): Promise<SecretStatus>;
  setSecret(slot: Slot, value: string): Promise<void>;
  clearSecret(slot: Slot): Promise<void>;
}

function pickIntegration(s: AppSettings): IntegrationSettingsValue {
  return {
    partbankDesktopUrl: s.partbankDesktopUrl,
    partbankWebUrl: s.partbankWebUrl,
    partbankDefaultConnection: s.partbankDefaultConnection,
    partbankSendUsages: s.partbankSendUsages,
    llmProvider: s.llmProvider,
    llmEndpointOllama: s.llmEndpointOllama,
    llmEndpointOpenai: s.llmEndpointOpenai,
    llmModel: s.llmModel,
    bfwUrl: s.bfwUrl,
    bfwConnection: s.bfwConnection,
    allowHttpOrigins: [...s.allowHttpOrigins],
  };
}

/**
 * 명령 맥락으로 대화상자의 바깥 함수를 만든다. 앱의 `ctx.settings` 는 다시 그려진 뒤에야 바뀌므로, 이 대화상자가 저장한
 * 값은 따로 들고 있다가 다음 저장의 '앞' 값으로 쓴다.
 */
export function integrationDepsFor(ctx: CommandContext, invoke: InvokeFn = tauriInvoke): IntegrationDeps {
  let current = pickIntegration(ctx.settings);
  return {
    value: () => current,
    async commit(patch) {
      const before = current;
      const after: IntegrationSettingsValue = { ...before, ...patch };
      current = after;
      // 먼저 저장한다: Rust 는 요청마다 저장된 설정에서 주소를 읽고, 고리(예: 사용처 동기화)는 새 값을 본다.
      await ctx.updateSettings(patch);
      await runIntegrationChangeHooks(before, after);
    },
    status: () => secretStatus(invoke),
    setSecret: (slot, value) => setSecret(slot, value, invoke),
    clearSecret: (slot) => clearSecret(slot, invoke),
  };
}

/** 연동 설정 대화상자를 연다. 바꾼 값은 열린 동안 칸마다 바로 저장된다. 닫히면 끝난다. */
export function openIntegrationSettings(deps: IntegrationDeps): Promise<void> {
  return openDialog<void>({ kind: 'integrationSettings', deps }, undefined);
}

/** `app.integration-settings` 명령. */
export function runIntegrationSettings(ctx: CommandContext): Promise<void> {
  return openIntegrationSettings(integrationDepsFor(ctx));
}

const DEFAULTS = fromPluginData(undefined);

const EMPTY_STATUS: SecretStatus = {
  set: { partbankDesktop: false, partbankWeb: false, llmOpenai: false, bfwServer: false, bfwDesktop: false },
  epoch: { partbankDesktop: 0, partbankWeb: 0, llmOpenai: 0, bfwServer: 0, bfwDesktop: 0 },
};

/** 키가 묶이는 주소 설정. 이 값이 바뀌면 키 상태를 다시 읽는다. */
const KEYED_ADDRESS_KEYS = ['partbankDesktopUrl', 'partbankWebUrl', 'bfwUrl', 'llmEndpointOpenai'] as const;

type OriginKey = 'partbankDesktopUrl' | 'partbankWebUrl' | 'bfwUrl';
type EndpointKey = 'llmEndpointOllama' | 'llmEndpointOpenai';
type DraftKey = OriginKey | EndpointKey | 'llmModel';
type Drafts = Record<DraftKey, string>;

const CLEARTEXT = 'This address is not encrypted, so the API key is sent in the clear.';
const FULL_ADDRESS = 'Enter a full address starting with http:// or https://.';

const originOf = (raw: string): URL | undefined => (isOriginUrl(raw) ? new URL(raw.trim()) : undefined);

/** "연결 시험" 단추와 그 결과 줄. 등록된 시험이 없으면 아무것도 그리지 않는다. */
function ProbeButton(props: { id: ProbeId; fields: () => Parameters<ProbeFn>[0] }) {
  const [state, setState] = useState<{ ok: boolean; message: string } | 'checking' | undefined>(undefined);
  const probe = probeFor(props.id);
  if (!probe) return null;
  const run = async () => {
    setState('checking');
    try {
      setState(await probe(props.fields()));
    } catch {
      setState({ ok: false, message: t('integrations.testFailed') });
    }
  };
  return (
    <div className="integration-test">
      <button type="button" disabled={state === 'checking'} onClick={() => void run()}>
        {coreT('Test connection')}
      </button>
      {state ? (
        <p role="status" className={state !== 'checking' && !state.ok ? 'prompt-hint warn' : 'prompt-hint'}>
          {state === 'checking' ? coreT('Checking…') : state.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 연동 설정 대화상자(D17): partbank, AI 제공자, bfworkflow 세 묶음. SampleSettingsDialog 처럼 플러그인 설정 탭의 줄을 그
 * 이름(coreT)으로 보인다. 주소 칸은 칸을 떠날 때 검사해 저장하고, 고르기와 스위치는 바로 저장한다. 키 칸은 쓰기만 한다.
 */
export function IntegrationSettingsDialog(props: { deps: IntegrationDeps; onDone: (value?: unknown) => void; onCancel: () => void }) {
  const { deps } = props;
  const id = useId();
  const valRef = useRef<IntegrationSettingsValue>(deps.value());
  const [val, setVal] = useState(valRef.current);
  const draftRef = useRef<Drafts>({
    partbankDesktopUrl: val.partbankDesktopUrl,
    partbankWebUrl: val.partbankWebUrl,
    bfwUrl: val.bfwUrl,
    llmEndpointOllama: val.llmEndpointOllama,
    llmEndpointOpenai: val.llmEndpointOpenai,
    llmModel: val.llmModel,
  });
  const [draft, setDraftState] = useState<Drafts>(draftRef.current);
  const [notice, setNotice] = useState<Partial<Record<EndpointKey, string>>>({});
  const [status, setStatus] = useState<SecretStatus>(EMPTY_STATUS);
  const keyRefs = {
    partbankDesktop: useRef<HTMLInputElement>(null),
    partbankWeb: useRef<HTMLInputElement>(null),
    llmOpenai: useRef<HTMLInputElement>(null),
    bfw: useRef<HTMLInputElement>(null),
  };
  const first = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    deps.status().then(
      (s) => live && setStatus(s),
      () => undefined,
    );
    first.current?.querySelector('input')?.focus();
    return () => {
      live = false;
    };
  }, [deps]);

  const setDraft = (key: DraftKey, value: string) => {
    draftRef.current = { ...draftRef.current, [key]: value };
    setDraftState(draftRef.current);
  };

  const save = async (patch: Partial<IntegrationSettingsValue>) => {
    valRef.current = { ...valRef.current, ...patch };
    setVal(valRef.current);
    try {
      await deps.commit(patch);
      // Rust 는 키를 주소(origin)에 묶는다(D6). 주소가 바뀌면 칸의 '설정됨' 여부도 바뀌므로 다시 읽어
      // 배지와 구독자(partbank 기능, bfworkflow 준비 상태)를 새 주소에 맞춘다.
      if (KEYED_ADDRESS_KEYS.some((k) => k in patch)) {
        const s = await deps.status();
        setStatus(s);
        notifySecretsChange(s);
      }
    } catch {
      // 저장 실패는 앱의 설정 저장이 따로 다룬다. 대화상자는 열린 채로 둔다.
    }
  };

  /** 주소(origin) 칸을 저장한다. 올바르지 않으면 저장하지 않고 false(경고는 칸 밑에 이미 보인다). */
  const commitOrigin = async (key: OriginKey): Promise<boolean> => {
    let v = draftRef.current[key].trim();
    if (v && !isOriginUrl(v)) return false;
    if (key === 'bfwUrl' && !v) v = BFW_DEFAULT_URL;
    if (v !== draftRef.current[key]) setDraft(key, v);
    if (v !== valRef.current[key]) await save({ [key]: v });
    return true;
  };

  /** LLM 주소 칸을 저장한다. 비우면 기본값으로 되돌리고 그 까닭을 보인다(플러그인 commitEndpoint, #555). */
  const commitEndpoint = async (key: EndpointKey): Promise<boolean> => {
    const raw = draftRef.current[key].trim();
    const endpoint = raw || DEFAULTS[key];
    setNotice((n) => ({ ...n, [key]: raw ? undefined : coreT('The endpoint cannot be empty, so it is back to {0}.', endpoint) }));
    if (endpoint !== draftRef.current[key]) setDraft(key, endpoint);
    if (endpoint !== valRef.current[key]) await save({ [key]: endpoint });
    return true;
  };

  const commitModel = async () => {
    const v = draftRef.current.llmModel.trim();
    if (v !== draftRef.current.llmModel) setDraft('llmModel', v);
    if (v !== valRef.current.llmModel) await save({ llmModel: v });
  };

  /** 닫기 전에 떠나지 않은 칸을 저장한다(칸이 사라질 때는 blur 가 오지 않는다). */
  const commitAll = async () => {
    await commitOrigin('partbankDesktopUrl');
    await commitOrigin('partbankWebUrl');
    if (valRef.current.bfwConnection === 'server') await commitOrigin('bfwUrl');
    if (valRef.current.llmProvider !== 'none') {
      await commitEndpoint(valRef.current.llmProvider === 'ollama' ? 'llmEndpointOllama' : 'llmEndpointOpenai');
      await commitModel();
    }
  };

  const toggleAllow = (origin: string) => {
    const list = valRef.current.allowHttpOrigins;
    const next = list.includes(origin) ? list.filter((o) => o !== origin) : [...list, origin];
    void save({ allowHttpOrigins: next });
  };

  /** 키를 보내는 주소의 경고와 허락 상자. */
  const cleartext = (url: URL | undefined) => {
    const origin = cleartextOrigin(url);
    if (!origin) return { warnings: [] as string[], box: null };
    return {
      warnings: [coreT(CLEARTEXT)],
      box: <AllowHttpBox checked={val.allowHttpOrigins.includes(origin)} onToggle={() => toggleAllow(origin)} />,
    };
  };

  const originField = (key: OriginKey, keyed: boolean) => {
    const raw = draft[key];
    if (raw.trim() && !isOriginUrl(raw)) return { warnings: [coreT(FULL_ADDRESS)], box: null };
    return keyed ? cleartext(originOf(raw)) : { warnings: [] as string[], box: null };
  };

  const keyValue = (ref: { current: HTMLInputElement | null }) => ref.current?.value.trim() || undefined;
  const onSaved = (s?: SecretStatus) => {
    if (s) setStatus(s);
  };

  const close = async () => {
    await commitAll();
    props.onDone(undefined);
  };
  const cancel = async () => {
    await commitAll();
    props.onCancel();
  };

  // ── partbank ──
  const partbankRows = (kind: 'desktop' | 'web') => {
    const isDesktop = kind === 'desktop';
    const slot = isDesktop ? ('partbankDesktop' as const) : ('partbankWeb' as const);
    const keyRef = isDesktop ? keyRefs.partbankDesktop : keyRefs.partbankWeb;
    const urlKey: OriginKey = isDesktop ? 'partbankDesktopUrl' : 'partbankWebUrl';
    const label = isDesktop ? coreT('partbank desktop app') : coreT('partbank server');
    const field = originField(urlKey, !isDesktop);
    return (
      <div className="integration-group" key={kind}>
        <UrlField
          label={coreT('{0} address', label)}
          hints={[
            isDesktop
              ? coreT('The address the desktop app serves its API on. Change it only if you moved its port.')
              : coreT('The address of your lab’s partbank server.'),
          ]}
          placeholder={isDesktop ? 'http://127.0.0.1:47830' : 'https://partbank.kbiofoundry.kr'}
          value={draft[urlKey]}
          onChange={(v) => setDraft(urlKey, v)}
          onCommit={() => void commitOrigin(urlKey)}
          warnings={field.warnings}
        >
          {field.box}
        </UrlField>
        <KeyField
          deps={deps}
          slot={slot}
          label={coreT('{0} API key', label)}
          hints={[overrideOr('integrations.keyKeptHere')]}
          isSet={status.set[slot]}
          placeholder="pbk_..."
          inputRef={keyRef}
          beforeSave={() => commitOrigin(urlKey)}
          onSaved={onSaved}
        />
        <ProbeButton
          id={slot}
          fields={() => ({ url: draftRef.current[urlKey].trim(), apiKey: keyValue(keyRef), connection: kind })}
        />
      </div>
    );
  };

  // ── AI ──
  const provider = val.llmProvider;
  const endpointKey: EndpointKey = provider === 'ollama' ? 'llmEndpointOllama' : 'llmEndpointOpenai';
  const endpointWarn = provider === 'openai' ? cleartext(resolveEndpoint(draft.llmEndpointOpenai)) : { warnings: [], box: null };

  // ── bfworkflow ──
  const bfwSlot: Slot = val.bfwConnection === 'desktop' ? 'bfwDesktop' : 'bfwServer';
  const bfwField = originField('bfwUrl', true);

  return (
    <DialogFrame title={t('cmd.integrationSettings')} className="prompt integration-settings" onCancel={() => void cancel()}>
      <div className="integration-body" ref={first}>
        <section className="integration-section">
          <h3>{coreT('partbank')}</h3>
          <p className="prompt-hint">{overrideOr('integrations.partbankIntro')}</p>
          {partbankRows('desktop')}
          {partbankRows('web')}
          <div className="integration-field">
            <label className="prompt-question" htmlFor={`${id}-pbconn`}>
              {coreT('Connection to search')}
            </label>
            <p className="prompt-hint">
              {coreT(
                'Which partbank the autocomplete search and the catalog download use. A link made through the desktop app points at this PC only, so a vault shared with the lab should use the server.',
              )}
            </p>
            <select
              id={`${id}-pbconn`}
              value={val.partbankDefaultConnection}
              onChange={(e) => void save({ partbankDefaultConnection: e.target.value as IntegrationSettingsValue['partbankDefaultConnection'] })}
            >
              <option value="web">{coreT('partbank server')}</option>
              <option value="desktop">{coreT('partbank desktop app')}</option>
            </select>
          </div>
          <div className="integration-field">
            <label className="prompt-question">
              <input
                type="checkbox"
                checked={val.partbankSendUsages}
                onChange={(e) => void save({ partbankSendUsages: e.target.checked })}
              />{' '}
              {coreT('Send note usages to partbank')}
            </label>
            <p className="prompt-hint">
              {coreT(
                'Lists the lab notes that use a sample from partbank on its partbank page. Note paths, experiment folder names and section titles are stored on the partbank server and shown to you only. Turning this off deletes what this PC sent.',
              )}
            </p>
          </div>
        </section>

        <section className="integration-section">
          <h3>{coreT('AI provider')}</h3>
          <div className="integration-field">
            <label className="prompt-question" htmlFor={`${id}-provider`}>
              {coreT('Provider')}
            </label>
            <select
              id={`${id}-provider`}
              value={provider}
              onChange={(e) => void save({ llmProvider: e.target.value as IntegrationSettingsValue['llmProvider'] })}
            >
              <option value="none">{coreT('Disabled')}</option>
              <option value="openai">OpenAI-compatible</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>
          {provider !== 'none' ? (
            <div className="integration-group">
              <UrlField
                key={endpointKey}
                label={provider === 'ollama' ? coreT('Ollama endpoint') : coreT('OpenAI endpoint')}
                hints={[overrideOr('ai.schemeHint')]}
                value={draft[endpointKey]}
                onChange={(v) => {
                  setDraft(endpointKey, v);
                  setNotice((n) => ({ ...n, [endpointKey]: undefined }));
                }}
                onCommit={() => void commitEndpoint(endpointKey)}
                warnings={[...(notice[endpointKey] ? [notice[endpointKey]!] : []), ...endpointWarn.warnings]}
              >
                {endpointWarn.box}
              </UrlField>
              <div className="integration-field">
                <label className="prompt-question" htmlFor={`${id}-model`}>
                  {coreT('Model')}
                </label>
                <input
                  id={`${id}-model`}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.llmModel}
                  onChange={(e) => setDraft('llmModel', e.target.value)}
                  onBlur={() => void commitModel()}
                />
              </div>
              {provider === 'openai' ? (
                <KeyField
                  deps={deps}
                  slot="llmOpenai"
                  label={coreT('API key')}
                  hints={[coreT('Only sent to OpenAI-compatible providers, never to Ollama.'), overrideOr('integrations.keyKeptHere')]}
                  isSet={status.set.llmOpenai}
                  inputRef={keyRefs.llmOpenai}
                  beforeSave={() => commitEndpoint('llmEndpointOpenai')}
                  onSaved={onSaved}
                />
              ) : null}
              <ProbeButton
                id="llm"
                fields={() => ({
                  url: draftRef.current[endpointKey].trim(),
                  provider,
                  model: draftRef.current.llmModel.trim(),
                  apiKey: provider === 'openai' ? keyValue(keyRefs.llmOpenai) : undefined,
                })}
              />
            </div>
          ) : null}
        </section>

        <section className="integration-section">
          <h3>{t('integrations.bfw.heading')}</h3>
          <div className="integration-field">
            <label className="prompt-question" htmlFor={`${id}-bfwconn`}>
              {t('integrations.bfw.connection')}
            </label>
            <select
              id={`${id}-bfwconn`}
              value={val.bfwConnection}
              onChange={(e) => void save({ bfwConnection: e.target.value as IntegrationSettingsValue['bfwConnection'] })}
            >
              <option value="server">{t('integrations.bfw.server')}</option>
              <option value="desktop">{t('integrations.bfw.desktop')}</option>
            </select>
          </div>
          {val.bfwConnection === 'server' ? (
            <UrlField
              label={t('integrations.bfw.url')}
              placeholder={BFW_DEFAULT_URL}
              value={draft.bfwUrl}
              onChange={(v) => setDraft('bfwUrl', v)}
              onCommit={() => void commitOrigin('bfwUrl')}
              warnings={bfwField.warnings}
            >
              {bfwField.box}
            </UrlField>
          ) : null}
          <KeyField
            key={bfwSlot}
            deps={deps}
            slot={bfwSlot}
            label={t('integrations.bfw.key')}
            hints={[t('integrations.bfw.keyHint'), overrideOr('integrations.keyKeptHere')]}
            isSet={status.set[bfwSlot]}
            inputRef={keyRefs.bfw}
            beforeSave={bfwSlot === 'bfwServer' ? () => commitOrigin('bfwUrl') : undefined}
            onSaved={onSaved}
          />
          <ProbeButton
            id="bfw"
            fields={() => ({
              url: val.bfwConnection === 'server' ? draftRef.current.bfwUrl.trim() : '',
              connection: val.bfwConnection,
              apiKey: keyValue(keyRefs.bfw),
            })}
          />
        </section>
      </div>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={() => void close()}>
          {t('integrations.close')}
        </button>
      </div>
    </DialogFrame>
  );
}
