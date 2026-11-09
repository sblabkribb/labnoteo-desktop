import { useId, type ReactNode } from 'react';
import { t } from '../i18n/t';

/**
 * 연동 설정의 주소 칸(D17). 칸을 떠날 때(`onCommit`) 저장하고, 경고는 칸의 지금 값으로 곧바로 보인다(플러그인의
 * showUrlState 와 같다). 순수한 화면이다: 검사와 저장은 대화상자가 한다.
 */
export function UrlField(props: {
  label: string;
  hints?: readonly string[];
  placeholder?: string;
  value: string;
  onChange(value: string): void;
  onCommit(): void;
  warnings?: readonly string[];
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="integration-field">
      <label className="prompt-question" htmlFor={id}>
        {props.label}
      </label>
      {(props.hints ?? []).map((h, i) => (
        <p key={`hint-${i}`} className="prompt-hint">
          {h}
        </p>
      ))}
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onCommit}
      />
      {(props.warnings ?? []).map((w, i) => (
        <p key={`warn-${i}`} role="alert" className="prompt-hint warn">
          {w}
        </p>
      ))}
      {props.children}
    </div>
  );
}

/** 암호화 없는 주소로 키를 보내도 된다는 허락(D7). 고르면 그 origin 이 `allowHttpOrigins` 에 들어간다. */
export function AllowHttpBox(props: { checked: boolean; onToggle(): void }) {
  return (
    <label className="integration-allow">
      <input type="checkbox" checked={props.checked} onChange={props.onToggle} /> {t('integrations.allowHttp')}
    </label>
  );
}

/** `localhost`, `127.0.0.0/8`, `[::1]`: Rust `net::config::is_loopback` 와 같은 규칙. */
export function isLoopbackUrl(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return h === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '[::1]';
}

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * LLM 주소를 Rust `parse_llm_endpoint` 처럼 읽는다: 스킴이 없으면 이 PC 주소는 http://, 다른 곳은 https://.
 * 읽을 수 없으면 undefined.
 */
export function resolveEndpoint(raw: string): URL | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (v.includes('://')) return parse(v);
  const plain = parse(`http://${v}`);
  if (plain && isLoopbackUrl(plain)) return plain;
  return parse(`https://${v}`);
}

/** 키가 암호화 없이 다른 컴퓨터로 갈 주소면 그 origin(소문자, 기본 포트 없음), 아니면 undefined. */
export function cleartextOrigin(url: URL | undefined): string | undefined {
  if (!url || url.protocol !== 'http:' || isLoopbackUrl(url)) return undefined;
  return url.origin;
}
