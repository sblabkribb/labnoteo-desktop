import { useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { t } from '../../i18n/t';
import { isComposing } from '../../labnote/host/DialogFrame';
import { toNetError } from '../netIpc';

/** 토큰 최대 길이(Rust `secrets::store_long`, spec §4.3). */
export const MCP_TOKEN_MAX = 8192;

const NAMED = ['kbf_sso_access_token', 'token', 'api_key', 'changeme', '...'];

/** 앞뒤 빈칸과 맨 앞의 `Bearer `(대소문자 무관)를 뺀 값. Rust `placeholder::strip_bearer` 와 같다. */
export function stripBearer(token: string): string {
  const v = token.trim();
  if (v.slice(0, 7).toLowerCase() === 'bearer ') return v.slice(7).trim();
  return v.toLowerCase() === 'bearer' ? '' : v;
}

/**
 * README 나 연결 예시의 자리 표시 값(`<YOUR_TOKEN>`, `${TOKEN}` …)이면 true. Rust `placeholder::is_placeholder` 와 같은
 * 규칙(spec §6.2): 이런 값은 자격 증명 관리자에 보내지 않는다.
 */
export function isPlaceholderToken(token: string): boolean {
  const v = stripBearer(token);
  if (!v) return true;
  const upper = v.toUpperCase();
  if (v.startsWith('<') && v.endsWith('>') && v.length >= 2 && !v.slice(1, -1).includes('>')) return true;
  const i = v.indexOf('${');
  if (i >= 0 && v.slice(i + 2).includes('}')) return true;
  if (v.length >= 4 && v.startsWith('{{') && v.endsWith('}}')) return true;
  if (v.length >= 3 && /^%[A-Z_]*%$/.test(v)) return true;
  if (upper.includes('YOUR_') || upper.includes('_HERE')) return true;
  if (NAMED.includes(v.toLowerCase())) return true;
  if ([...v].length >= 3 && /^[xX]+$/.test(v)) return true;
  return /^[.…]+$/.test(v) && (v.includes('…') || v.length >= 3);
}

/** 토큰 저장이 거절된 까닭을 한 줄로. Rust 의 글(`message`)은 보이지 않는다. */
function saveErrorLine(e: unknown): string {
  const err = toNetError(e);
  if (err.kind !== 'badInput') return t('mcpClient.err.keychain');
  // Rust 의 고정된 거절 글로 까닭을 가른다(값은 들어 있지 않다).
  if (err.message.includes('placeholder')) return t('mcpClient.err.placeholder');
  return t('mcpClient.err.tokenTooLong');
}

/**
 * 쓰기만 하는 MCP 토큰 칸(spec §6.1). `KeyField` 와 같이 친 값은 React 상태에 두지 않는다: 누를 때 ref 로 읽고 곧바로 칸을
 * 비운 뒤 `save(value)` 로 한 번 보낸다. 자리 표시 값과 너무 긴 값은 보내지 않는다. 한글 조합 중의 Enter 는 저장하지 않는다.
 */
export function McpKeyField(p: {
  label: string;
  hint?: string;
  isSet: boolean;
  save(v: string): Promise<void>;
  clear(): Promise<void>;
  inputRef?: Ref<HTMLInputElement>;
  onSaved(): void;
}): JSX.Element {
  const id = useId();
  const own = useRef<HTMLInputElement | null>(null);
  const busy = useRef(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const setRef = (el: HTMLInputElement | null) => {
    own.current = el;
    const r = p.inputRef;
    if (typeof r === 'function') r(el);
    else if (r) (r as { current: HTMLInputElement | null }).current = el;
  };

  const save = async () => {
    const input = own.current;
    if (busy.current || !input) return;
    const raw = input.value;
    // 값은 칸에 남겨 두지 않는다: 보내기 전에 비운다.
    input.value = '';
    if (!raw.trim()) return;
    setError(undefined);
    if (isPlaceholderToken(raw)) {
      setError(t('mcpClient.err.placeholder'));
      return;
    }
    if ([...stripBearer(raw)].length > MCP_TOKEN_MAX) {
      setError(t('mcpClient.err.tokenTooLong'));
      return;
    }
    busy.current = true;
    try {
      await p.save(raw.trim());
    } catch (e) {
      setError(saveErrorLine(e));
      return;
    } finally {
      busy.current = false;
    }
    p.onSaved();
  };

  const remove = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(undefined);
    try {
      await p.clear();
    } catch {
      setError(t('mcpClient.err.keychain'));
      return;
    } finally {
      busy.current = false;
    }
    p.onSaved();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    void save();
  };

  return (
    <div className="integration-field integration-key">
      <div className="integration-key-head">
        <label className="prompt-question" htmlFor={id}>
          {p.label}
        </label>
        <span className={p.isSet ? 'integration-key-state set' : 'integration-key-state'}>
          {p.isSet ? t('integrations.keySet') : t('integrations.keyNotSet')}
        </span>
      </div>
      {p.hint ? <p className="prompt-hint">{p.hint}</p> : null}
      <div className="integration-key-row">
        <input ref={setRef} id={id} type="password" autoComplete="off" spellCheck={false} defaultValue="" onKeyDown={onKeyDown} />
        <button type="button" onClick={() => void save()}>
          {t('mcpClient.saveToken')}
        </button>
        {p.isSet ? (
          <button type="button" onClick={() => void remove()}>
            {t('mcpClient.removeToken')}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="prompt-hint warn">
          {error}
        </p>
      ) : null}
    </div>
  );
}
