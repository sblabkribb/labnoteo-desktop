import { useEffect, useId, useRef, useState, type DragEvent, type MutableRefObject } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import { coreT, overrideOr } from '../labnote/i18n';
import type { CommandContext } from '../labnote/commands/context';
import type { Notify } from '../labnote/mcp/commands';
import { McpSection } from '../labnote/mcp/McpSection';
import { SkillSection } from '../labnote/skill/SkillSection';
import { ContextWindowField } from '../labnote/context/ContextWindowField';
import {
  BFW_DEFAULT_URL,
  LLM_CONTEXT_WINDOW_DEFAULT,
  cleanMcpServers,
  fromPluginData,
  isOriginUrl,
  type AppSettings,
} from '../labnote/settings';
import { KeyField } from './KeyField';
import { notifySecretsChange } from './secretsEvents';
import { clearSecret, secretStatus, setSecret, type InvokeFn, type SecretStatus, type Slot } from './netIpc';
import { probeFor, runIntegrationChangeHooks, type IntegrationSettingsValue, type ProbeFn, type ProbeId } from './probes';
import { AllowHttpBox, cleartextOrigin, resolveEndpoint, UrlField } from './UrlField';
import { ScanSettingsSection } from '../labnote/scan/ScanSettingsSection';
import type { RawInvoke } from '../fs/vaultImage';
import {
  checkDroppedFiles,
  deleteImportedFile,
  importConnectionsBytes,
  importConnectionsFile,
  MAX_IMPORT_BYTES,
  type DeleteOutcome,
  type ImportOutcome,
  type ImportPart,
  type ImportProblem,
  type ImportRefusal,
} from './importFile';
import { SelectField } from '../ui/SelectField';
import { McpClientSection, mcpClientDepsFor, type McpClientDeps } from './mcpClient/McpClientSection';
import { ScholarSection } from './scholar/ScholarSection';

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
  /** MCP 묶음(SP7 Part C)이 알림을 띄우고 Rust 를 부를 때. 없으면 MCP 묶음을 그리지 않는다. */
  mcp?: { notify: Notify; invoke?: InvokeFn };
  /** 외부 MCP 서버(MCP 클라이언트, spec §6.1). `mcp` 는 앱 자신의 서버다. 없으면 "외부 MCP 서버" 묶음을 그리지 않는다. */
  mcpClient?: McpClientDeps;
  /**
   * "파일에서 가져오기". `run` 은 Rust 가 고르기 창을 띄우고 읽고 키를 저장한 뒤 요약과 설정을 돌려준다(취소하면 null).
   * `runBytes` 는 끌어 놓은 파일의 바이트를 같은 검사와 해석으로 가져온다. `remove` 는 Rust 가 기억한 마지막으로 고른
   * 파일만 지운다. 없으면 가져오기 묶음을 그리지 않는다.
   */
  importFile?: {
    run(): Promise<ImportOutcome | null>;
    runBytes(name: string, bytes: Uint8Array): Promise<ImportOutcome>;
    remove(permanent: boolean): Promise<DeleteOutcome>;
  };
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
    llmContextWindow: s.llmContextWindow,
    bfwUrl: s.bfwUrl,
    bfwConnection: s.bfwConnection,
    allowHttpOrigins: [...s.allowHttpOrigins],
    worksheetPaperSize: s.worksheetPaperSize,
    scanMaxImageEdge: s.scanMaxImageEdge,
    scanJpegQuality: s.scanJpegQuality,
    scanEmbedWidth: s.scanEmbedWidth,
    mcpEnabled: s.mcpEnabled,
    mcpPort: s.mcpPort,
    mcpClientServers: s.mcpClientServers.map((m) => ({ ...m, tools: { ...m.tools } })),
    scholarSources: { ...s.scholarSources },
    ncbiEmail: s.ncbiEmail,
    crossrefMailto: s.crossrefMailto,
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
      // 앱의 updateSettings 는 던지지 않고 false 로 저장 실패를 알린다. 여기서는 던져서 대화상자가 실패로 다루게 한다.
      if ((await ctx.updateSettings(patch)) === false) throw new Error('settings were not saved');
      await runIntegrationChangeHooks(before, after);
    },
    status: () => secretStatus(invoke),
    setSecret: (slot, value) => setSecret(slot, value, invoke),
    clearSecret: (slot) => clearSecret(slot, invoke),
    mcp: { notify: (kind, message) => ctx.host.notify(kind, message), invoke },
    mcpClient: mcpClientDepsFor(invoke),
    importFile: {
      run: () => importConnectionsFile(t('integrations.import.pickTitle'), invoke),
      runBytes: (name, bytes) => importConnectionsBytes(name, bytes, invoke as unknown as RawInvoke),
      remove: (permanent) => deleteImportedFile(permanent, invoke),
    },
  };
}

const DEFAULTS = fromPluginData(undefined);

const EMPTY_STATUS: SecretStatus = {
  set: { partbankDesktop: false, partbankWeb: false, llmOpenai: false, bfwServer: false, bfwDesktop: false, slackBot: false, ncbiEutils: false },
  epoch: { partbankDesktop: 0, partbankWeb: 0, llmOpenai: 0, bfwServer: 0, bfwDesktop: 0, slackBot: 0, ncbiEutils: 0 },
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

/** 가져오기 결과 줄. `warn` 이면 경고로 보인다. */
interface ImportLine {
  text: string;
  warn: boolean;
}

/** 번역 키는 글자 그대로 둔다(카탈로그 검사가 키를 찾는다). */
const PART_LABEL: Record<ImportPart, () => string> = {
  llm: () => t('integrations.import.part.llm'),
  partbank: () => t('integrations.import.part.partbank'),
  bfworkflow: () => t('integrations.import.part.bfworkflow'),
  mcpServer: () => t('mcpClient.import.part'),
};

const REFUSAL_TEXT: Record<ImportRefusal, () => string> = {
  insideVault: () => t('integrations.import.refused.insideVault'),
  tooLarge: () => t('integrations.import.refused.tooLarge'),
  unreadable: () => t('integrations.import.refused.unreadable'),
  notText: () => t('integrations.import.refused.notText'),
  unrecognized: () => t('integrations.import.refused.unrecognized'),
  wrongType: () => t('integrations.import.refused.wrongType'),
};

/** 끌어 놓은 파일을 Rust 에 보내기 전에 거절한 까닭. */
const DROP_REFUSAL_TEXT: Record<'oneFile' | 'tooLarge' | 'wrongType', () => string> = {
  oneFile: () => t('integrations.import.dropOneFile'),
  tooLarge: () => t('integrations.import.refused.tooLarge'),
  wrongType: () => t('integrations.import.refused.wrongType'),
};

/** 파일의 바이트. `File.arrayBuffer` 가 없는 환경에서는 FileReader 로 읽는다. */
function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

const PROBLEM_TEXT: Record<ImportProblem, () => string> = {
  badUrl: () => t('integrations.import.reason.badUrl'),
  badKey: () => t('integrations.import.reason.badKey'),
  badModel: () => t('integrations.import.reason.badModel'),
  badProvider: () => t('integrations.import.reason.badProvider'),
  badConnection: () => t('integrations.import.reason.badConnection'),
  notText: () => t('integrations.import.reason.notText'),
  noUrl: () => t('integrations.import.reason.noUrl'),
  keyNotUsed: () => t('integrations.import.reason.keyNotUsed'),
  keychain: () => t('integrations.import.reason.keychain'),
  // MCP 서버 항목에만 오는 까닭(줄은 MCP_PROBLEM_TEXT 가 서버 이름과 함께 만든다).
  stdioSkipped: () => t('mcpClient.import.stdio', ''),
  sseSkipped: () => t('mcpClient.import.sse', ''),
  badType: () => t('mcpClient.import.badType', ''),
  otherHeaders: () => t('mcpClient.import.otherHeaders', ''),
  needsToken: () => t('mcpClient.import.needsToken', ''),
  urlSecret: () => t('mcpClient.import.urlSecret', ''),
  tooMany: () => t('mcpClient.import.tooMany', ''),
};

/** MCP 서버 항목의 줄: "{이름}: 까닭"(spec §9). 이름은 파일의 키를 다듬은 것이고 평문으로만 보인다. */
const MCP_PROBLEM_TEXT: Partial<Record<ImportProblem, (name: string) => string>> = {
  stdioSkipped: (n) => t('mcpClient.import.stdio', n),
  sseSkipped: (n) => t('mcpClient.import.sse', n),
  badType: (n) => t('mcpClient.import.badType', n),
  otherHeaders: (n) => t('mcpClient.import.otherHeaders', n),
  needsToken: (n) => t('mcpClient.import.needsToken', n),
  urlSecret: (n) => t('mcpClient.import.urlSecret', n),
  tooMany: (n) => t('mcpClient.import.tooMany', n),
  badUrl: (n) => t('mcpClient.import.badUrl', n),
  notText: (n) => t('mcpClient.import.notText', n),
  badKey: (n) => t('mcpClient.import.badToken', n),
  keychain: (n) => t('mcpClient.import.keychain', n),
};

const DELETED_TEXT: Record<Exclude<DeleteOutcome, 'trashUnavailable'>, () => string> = {
  trashed: () => t('integrations.import.trashed'),
  deleted: () => t('integrations.import.deleted'),
  gone: () => t('integrations.import.gone'),
};

/** Rust 요약을 화면 줄로. 파일 내용은 들어 있지 않다(부분, 필드 이름, 까닭은 고정된 코드다). */
function summaryLines(out: ImportOutcome): ImportLine[] {
  if (out.status === 'refused') return [{ text: REFUSAL_TEXT[out.reason](), warn: true }];
  const lines: ImportLine[] = out.imported.map((i) => ({
    text: t(i.keySaved ? 'integrations.import.importedKey' : 'integrations.import.imported', PART_LABEL[i.part]()),
    warn: false,
  }));
  const mcp = out.mcp ?? [];
  for (const m of mcp) {
    lines.push({ text: t(m.tokenStored ? 'mcpClient.import.doneToken' : 'mcpClient.import.done', m.name), warn: false });
  }
  if (out.imported.length === 0 && mcp.length === 0) lines.push({ text: t('integrations.import.nothing'), warn: true });
  for (const i of out.invalid) {
    const mcpLine = i.part === 'mcpServer' ? MCP_PROBLEM_TEXT[i.reason] : undefined;
    if (mcpLine) {
      lines.push({ text: mcpLine(i.name ?? '?'), warn: true });
      continue;
    }
    lines.push({
      text: t('integrations.import.invalid', PART_LABEL[i.part](), i.field, PROBLEM_TEXT[i.reason]()),
      warn: true,
    });
  }
  return lines;
}

/** "연결 시험" 단추와 그 결과 줄. 등록된 시험이 없으면 아무것도 그리지 않는다. */
/**
 * "Test connection" and its result. `target` names what is tested (the address, provider, model, connection): the
 * result is for that target only, so it is cleared when the target changes, and an answer for an earlier target is
 * dropped (SP6-B3).
 */
function ProbeButton(props: { id: ProbeId; target: string; fields: () => Parameters<ProbeFn>[0] }) {
  const [state, setState] = useState<{ ok: boolean; message: string } | 'checking' | undefined>(undefined);
  const runId = useRef(0);
  const target = useRef(props.target);
  if (target.current !== props.target) {
    target.current = props.target;
    runId.current++;
    if (state !== undefined) setState(undefined);
  }
  const probe = probeFor(props.id);
  if (!probe) return null;
  const run = async () => {
    const mine = ++runId.current;
    setState('checking');
    let out: { ok: boolean; message: string };
    try {
      out = await probe(props.fields());
    } catch {
      out = { ok: false, message: t('integrations.testFailed') };
    }
    if (runId.current === mine) setState(out);
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
 * 연동 설정 쪽(D17, UI 재설계 Task 8): 설정 창의 "연동" 쪽에 들어간다. partbank, AI 제공자, bfworkflow, 바코드와 스캔, MCP.
 * 플러그인 설정 탭의 줄을 그 이름(coreT)으로 보인다. 주소 칸은 칸을 떠날 때 검사해 저장하고, 고르기와 스위치는 바로 저장한다.
 * 키 칸은 쓰기만 한다.
 *
 * - `commitRef`: 설정 창이 닫히기 전에 부를, 아직 떠나지 않은 칸의 저장(칸이 사라질 때는 blur 가 오지 않는다).
 * - `onLeave`: 다른 대화상자를 여는 동작(스캔 폴더 고르기 등)이 설정 창을 먼저 닫을 때. 그 대화상자가 이 창 뒤에 줄 서지 않게.
 * - `autoFocus`: 처음 칸에 초점을 줄지. 설정 창은 왼쪽 목록에 초점을 두므로 주지 않는다.
 */
export function IntegrationSettingsPage(props: {
  deps: IntegrationDeps;
  onLeave: () => Promise<void>;
  commitRef?: MutableRefObject<(() => Promise<void>) | null>;
  autoFocus?: boolean;
}) {
  const { deps } = props;
  const autoFocus = useRef(props.autoFocus === true);
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
  const [importBusy, setImportBusy] = useState(false);
  const [importLines, setImportLines] = useState<ImportLine[]>([]);
  /** 가져온 파일 지우기를 묻는 중: 휴지통으로(trash), 휴지통이 안 되면 영구히(permanent). */
  const [deleteAsk, setDeleteAsk] = useState<'trash' | 'permanent' | undefined>(undefined);
  /** 연결 파일을 끌고 가져오기 칸 위에 있는 중. */
  const [dropOver, setDropOver] = useState(false);
  /** "JSON 붙여넣기" 칸이 열려 있다. 붙여 넣은 글은 React 상태에 두지 않는다(제어하지 않는 칸, ref 로만 읽는다). */
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  /** 가져오기가 `mcpClientServers` 를 바꿀 때마다 올려, "외부 MCP 서버" 묶음이 새 목록으로 다시 그려지게 한다. */
  const [mcpGen, setMcpGen] = useState(0);
  /** 가져온 뒤 토큰 칸에 포커스를 줄 서버 id(토큰을 넣어 달라는 서버). */
  const [mcpFocus, setMcpFocus] = useState<string | undefined>(undefined);
  /** 섹션이 맡긴, 아직 떠나지 않은 칸의 저장(플러그인 ctx.onHide). 닫기 전에 부른다. */
  const hideCommits = useRef<Array<() => Promise<void>>>([]);

  useEffect(() => {
    let live = true;
    deps.status().then(
      (s) => live && setStatus(s),
      () => undefined,
    );
    if (autoFocus.current) first.current?.querySelector('input')?.focus();
    return () => {
      live = false;
    };
  }, [deps]);

  const setDraft = (key: DraftKey, value: string) => {
    draftRef.current = { ...draftRef.current, [key]: value };
    setDraftState(draftRef.current);
  };

  /** 설정을 저장한다. 저장하지 못했으면 false(앱의 설정 저장이 따로 알린다. 대화상자는 열린 채로 둔다). */
  const save = async (patch: Partial<IntegrationSettingsValue>): Promise<boolean> => {
    valRef.current = { ...valRef.current, ...patch };
    setVal(valRef.current);
    try {
      await deps.commit(patch);
    } catch {
      return false;
    }
    // Rust 는 키를 주소(origin)에 묶는다(D6). 주소가 바뀌면 칸의 '설정됨' 여부도 바뀌므로 다시 읽어
    // 배지와 구독자(partbank 기능, bfworkflow 준비 상태)를 새 주소에 맞춘다.
    if (KEYED_ADDRESS_KEYS.some((k) => k in patch)) {
      try {
        const s = await deps.status();
        setStatus(s);
        notifySecretsChange(s);
      } catch {
        // 상태를 읽지 못해도 설정은 저장됐다. 다음에 열면 새 상태를 읽는다.
      }
    }
    return true;
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
    for (const commit of hideCommits.current) await commit();
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

  /**
   * 가져온 결과를 반영한다: 요약 → 설정 저장(늘 쓰는 흐름) → 키 상태 다시 읽기 → 고른 파일이면 지우기 제안, 끌어 놓은
   * 파일이면 "직접 지우세요". 설정을 저장하지 못하면 경고하고 지우기를 제안하지 않는다(파일이 유일한 원본일 수 있다).
   */
  const applyImport = async (out: ImportOutcome, source: 'picked' | 'dropped' | 'pasted') => {
    if (out.status === 'done' && out.settings.mcpClientServers !== undefined) {
      // Rust 가 만든 전체 목록도 설정 규칙으로 한 번 더 거른다(fromStored 와 같은 검사).
      const cleaned = cleanMcpServers(out.settings.mcpClientServers, valRef.current.allowHttpOrigins);
      out = { ...out, settings: { ...out.settings, mcpClientServers: cleaned } };
    }
    const lines = summaryLines(out);
    // 파일이 공급자를 말하지 않으면 저장된 공급자를 그대로 둔다(Rust). 그것이 '없음'이면 AI 는 꺼진 채라서 알린다.
    if (
      out.status === 'done' &&
      out.imported.some((i) => i.part === 'llm') &&
      !('llmProvider' in out.settings) &&
      valRef.current.llmProvider === 'none'
    ) {
      lines.push({ text: t('integrations.import.chooseProvider'), warn: true });
    }
    setImportLines(lines);
    if (out.status !== 'done') return;
    const patch = out.settings;
    for (const [k, v] of Object.entries(patch)) {
      if (k in draftRef.current && typeof v === 'string') setDraft(k as DraftKey, v);
    }
    setNotice({});
    const saved = Object.keys(patch).length === 0 || (await save(patch));
    // Rust 가 키를 저장했다: 주소가 그대로여도 '설정됨'과 epoch 가 바뀌었을 수 있다.
    try {
      const s = await deps.status();
      setStatus(s);
      notifySecretsChange(s);
    } catch {
      // 상태를 읽지 못해도 가져오기는 끝났다. 다음에 열면 새 상태를 읽는다.
    }
    if (!saved) {
      setImportLines([...lines, { text: t('integrations.import.saveFailed'), warn: true }]);
      return;
    }
    const mcp = out.mcp ?? [];
    if ('mcpClientServers' in patch) {
      // 새 목록으로 "외부 MCP 서버" 묶음을 다시 그리고, 토큰을 넣어야 하는 첫 서버의 토큰 칸에 포커스를 준다.
      setMcpFocus(mcp.find((m) => m.needsToken)?.id);
      setMcpGen((g) => g + 1);
    }
    if (out.imported.length === 0 && mcp.length === 0) return;
    if (source === 'pasted') return;
    if (source === 'picked') setDeleteAsk('trash');
    else setImportLines([...lines, { text: t('integrations.import.dropDeleteYourself'), warn: true }]);
  };

  /** 파일에서 가져오기: Rust 가 고르기 창을 띄우고 읽고 키를 저장한다. 취소하면 아무것도 하지 않는다. */
  const runImport = async () => {
    const io = deps.importFile;
    if (!io || importBusy) return;
    setImportBusy(true);
    try {
      let out: ImportOutcome | null;
      try {
        out = await io.run();
      } catch {
        setDeleteAsk(undefined);
        setImportLines([{ text: t('integrations.import.failed'), warn: true }]);
        return;
      }
      if (!out) return;
      setDeleteAsk(undefined);
      await applyImport(out, 'picked');
    } catch {
      setImportLines([{ text: t('integrations.import.failed'), warn: true }]);
    } finally {
      setImportBusy(false);
    }
  };

  const onDropOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDropOver(true);
  };

  /** 끌어 놓은 연결 파일: 하나, 64 KiB 이하, 받는 확장자일 때만 바이트를 한 번 Rust 에 보낸다. */
  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropOver(false);
    const io = deps.importFile;
    if (!io || importBusy) return;
    const checked = checkDroppedFiles(e.dataTransfer?.files ?? []);
    setDeleteAsk(undefined);
    if ('refused' in checked) {
      setImportLines([{ text: DROP_REFUSAL_TEXT[checked.refused](), warn: true }]);
      return;
    }
    setImportBusy(true);
    try {
      let out: ImportOutcome;
      let bytes: Uint8Array | undefined;
      try {
        bytes = await fileBytes(checked.file);
        out = await io.runBytes(checked.file.name, bytes);
      } catch {
        setImportLines([{ text: t('integrations.import.failed'), warn: true }]);
        return;
      } finally {
        // 키가 든 바이트를 쥐고 있지 않는다(보낸 쪽도 지우지만 여기서 한 번 더).
        bytes?.fill(0);
      }
      await applyImport(out, 'dropped');
    } catch {
      setImportLines([{ text: t('integrations.import.failed'), warn: true }]);
    } finally {
      setImportBusy(false);
    }
  };

  /**
   * "JSON 붙여넣기" → "가져오기"(spec §6.2): 칸의 글을 ref 로 읽어 바이트로 바꾸고, 칸을 곧바로 비운다. 64 KiB 를 넘으면
   * Rust 를 부르지 않고 거절한다. 끌어 놓은 파일과 같은 길(`runBytes("pasted.json", …)`)로 보내고, 보낸 뒤 버퍼를 0 으로 지운다.
   */
  const runPaste = async () => {
    const io = deps.importFile;
    const area = pasteRef.current;
    if (!io || !area || importBusy) return;
    const bytes = new TextEncoder().encode(area.value);
    area.value = '';
    setDeleteAsk(undefined);
    if (bytes.length === 0) return;
    if (bytes.length > MAX_IMPORT_BYTES) {
      bytes.fill(0);
      setImportLines([{ text: t('integrations.import.refused.tooLarge'), warn: true }]);
      return;
    }
    setImportBusy(true);
    try {
      let out: ImportOutcome;
      try {
        out = await io.runBytes('pasted.json', bytes);
      } catch {
        setImportLines([{ text: t('integrations.import.failed'), warn: true }]);
        return;
      } finally {
        bytes.fill(0);
      }
      await applyImport(out, 'pasted');
    } catch {
      setImportLines([{ text: t('integrations.import.failed'), warn: true }]);
    } finally {
      setImportBusy(false);
    }
  };

  /** 섹션이 닫기 전에 부를 저장을 맡긴다(같은 함수는 한 번만). */
  const registerHide = useRef((commit: () => Promise<void>) => {
    if (!hideCommits.current.includes(commit)) hideCommits.current.push(commit);
  }).current;

  const addImportLine = (line: ImportLine) => setImportLines((lines) => [...lines, line]);

  /** 가져온 파일을 지운다. 휴지통이 안 되면 영구 삭제를 한 번 더 묻는다. */
  const removeImported = async (permanent: boolean) => {
    const io = deps.importFile;
    if (!io) return;
    setDeleteAsk(undefined);
    try {
      const r = await io.remove(permanent);
      if (r === 'trashUnavailable') {
        setDeleteAsk('permanent');
        return;
      }
      addImportLine({ text: DELETED_TEXT[r](), warn: false });
    } catch {
      addImportLine({ text: t('integrations.import.deleteFailed'), warn: true });
    }
  };

  const asksTrash = deleteAsk === 'trash';

  const keepImported = () => {
    setDeleteAsk(undefined);
    addImportLine({ text: t('integrations.import.kept'), warn: true });
  };

  const keyValue = (ref: { current: HTMLInputElement | null }) => ref.current?.value.trim() || undefined;
  const onSaved = (s?: SecretStatus) => {
    if (s) setStatus(s);
  };

  // 설정 창이 닫히기 전에 부른다. 렌더마다 최신 함수로 바꿔 둔다(commitAll 은 ref 만 읽지만 hideCommits 도 같은 ref 다).
  if (props.commitRef) props.commitRef.current = commitAll;
  const leave = async () => {
    await commitAll();
    await props.onLeave();
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
          target={`${kind}|${draft[urlKey].trim()}`}
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
      <div className="integration-body" ref={first}>
        {deps.importFile ? (
          <section className="integration-section">
            <div className="integration-test">
              <button type="button" disabled={importBusy} onClick={() => void runImport()}>
                {t('integrations.import.button')}
              </button>
            </div>
            <p className="prompt-hint">{t('integrations.import.hint')}</p>
            <div
              className={dropOver ? 'integration-drop over' : 'integration-drop'}
              onDragOver={onDropOver}
              onDragEnter={onDropOver}
              onDragLeave={() => setDropOver(false)}
              onDrop={(e) => void onDrop(e)}
            >
              {t('integrations.import.dropHere')}
            </div>
            <div className="integration-test">
              <button type="button" aria-expanded={pasteOpen} onClick={() => setPasteOpen((o) => !o)}>
                {t('mcpClient.import.paste')}
              </button>
            </div>
            {pasteOpen ? (
              <div className="integration-field">
                <p className="prompt-hint">{t('mcpClient.import.pasteHint')}</p>
                <textarea
                  ref={pasteRef}
                  className="integration-paste"
                  aria-label={t('mcpClient.import.paste')}
                  autoComplete="off"
                  spellCheck={false}
                  rows={6}
                />
                <div className="integration-test">
                  <button type="button" disabled={importBusy} onClick={() => void runPaste()}>
                    {t('mcpClient.import.run')}
                  </button>
                </div>
              </div>
            ) : null}
            {importLines.length > 0 ? (
              <div role="status" className="integration-field">
                {importLines.map((line, i) => (
                  <p key={i} className={line.warn ? 'prompt-hint warn' : 'prompt-hint'}>
                    {line.text}
                  </p>
                ))}
              </div>
            ) : null}
            {deleteAsk ? (
              <div className="integration-field">
                <p className="prompt-hint warn">
                  {t(asksTrash ? 'integrations.import.deleteAsk' : 'integrations.import.permanentAsk')}
                </p>
                <div className="integration-test">
                  <button type="button" onClick={() => void removeImported(!asksTrash)}>
                    {t(asksTrash ? 'integrations.import.deleteYes' : 'integrations.import.permanentYes')}
                  </button>
                  <button type="button" onClick={keepImported}>
                    {t('integrations.import.keep')}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
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
            <SelectField
              id={`${id}-pbconn`}
              value={val.partbankDefaultConnection}
              onChange={(e) => void save({ partbankDefaultConnection: e.target.value as IntegrationSettingsValue['partbankDefaultConnection'] })}
            >
              <option value="web">{coreT('partbank server')}</option>
              <option value="desktop">{coreT('partbank desktop app')}</option>
            </SelectField>
          </div>
          <div className="integration-field">
            <label className="prompt-question switch-label">
              <input
                type="checkbox"
                role="switch"
                className="switch"
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
          <h3>{overrideOr('integrations.aiProvider') /* coreT('AI provider') */}</h3>
          <div className="integration-field">
            <label className="prompt-question" htmlFor={`${id}-provider`}>
              {overrideOr('integrations.provider') /* coreT('Provider') */}
            </label>
            <SelectField
              id={`${id}-provider`}
              value={provider}
              onChange={(e) => void save({ llmProvider: e.target.value as IntegrationSettingsValue['llmProvider'] })}
            >
              <option value="none">{coreT('Disabled')}</option>
              <option value="openai">OpenAI-compatible</option>
              <option value="ollama">Ollama</option>
            </SelectField>
          </div>
          {provider !== 'none' ? (
            <div className="integration-group">
              <UrlField
                key={endpointKey}
                label={provider === 'ollama' ? coreT('Ollama endpoint') : coreT('OpenAI endpoint')}
                hints={provider === 'openai' ? [overrideOr('ai.schemeHint'), t('ai.openaiEndpointHint')] : [overrideOr('ai.schemeHint')]}
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
              <ContextWindowField value={val.llmContextWindow ?? LLM_CONTEXT_WINDOW_DEFAULT} commit={async (patch) => { await save(patch); }} />
              {provider === 'openai' ? (
                <KeyField
                  deps={deps}
                  slot="llmOpenai"
                  label={coreT('API key')}
                  hints={[overrideOr('integrations.openaiOnlyHint'), overrideOr('integrations.keyKeptHere')]}
                  isSet={status.set.llmOpenai}
                  inputRef={keyRefs.llmOpenai}
                  beforeSave={() => commitEndpoint('llmEndpointOpenai')}
                  onSaved={onSaved}
                />
              ) : null}
              <ProbeButton
                id="llm"
                target={`${provider}|${draft[endpointKey].trim()}|${draft.llmModel.trim()}`}
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
            <SelectField
              id={`${id}-bfwconn`}
              value={val.bfwConnection}
              onChange={(e) => void save({ bfwConnection: e.target.value as IntegrationSettingsValue['bfwConnection'] })}
            >
              <option value="server">{t('integrations.bfw.server')}</option>
              <option value="desktop">{t('integrations.bfw.desktop')}</option>
            </SelectField>
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
            target={`${val.bfwConnection}|${val.bfwConnection === 'server' ? draft.bfwUrl.trim() : ''}`}
            fields={() => ({
              url: val.bfwConnection === 'server' ? draftRef.current.bfwUrl.trim() : '',
              connection: val.bfwConnection,
              apiKey: keyValue(keyRefs.bfw),
            })}
          />
        </section>

        <McpClientSection key={mcpGen} deps={deps} onHide={registerHide} focusServer={mcpFocus} />

        <ScholarSection
          value={{ scholarSources: val.scholarSources, ncbiEmail: val.ncbiEmail, crossrefMailto: val.crossrefMailto }}
          save={save}
          deps={deps}
          ncbiKeySet={status.set.ncbiEutils}
          onSaved={onSaved}
          onHide={registerHide}
        />

        {/* SP7 Part B: 바코드와 스캔, Slack(Task 29) */}
        <ScanSettingsSection
          deps={deps}
          secrets={status}
          onSecrets={setStatus}
          onLeave={leave}
          onHide={registerHide}
        />
        {deps.mcp ? (
          <McpSection
            enabled={val.mcpEnabled}
            port={val.mcpPort}
            commit={async (patch) => {
              await save(patch);
            }}
            notify={deps.mcp.notify}
            invoke={deps.mcp.invoke}
          />
        ) : null}
        {deps.mcp ? <SkillSection notify={deps.mcp.notify} invoke={deps.mcp.invoke} /> : null}
      </div>
  );
}
