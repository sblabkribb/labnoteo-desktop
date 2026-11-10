import { useEffect, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import { isSystemPath } from '../tree/useTree';
import { searchNotes, type SearchResults } from './indexApi';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const LIMIT = 50;
/** 타이핑이 멈추고 이만큼 지나야 묻는다: 글자마다 보관함을 훑지 않게. */
const DEBOUNCE_MS = 150;

interface Props {
  /** 결과를 고르면 그 노트의 vault-relative 경로로 부른다. */
  onOpen: (path: string) => void;
  /** 시스템 파일(resources/workflows, resources/labsamples 아래)의 결과도 보인다. 기본은 거른다. */
  showSystem?: boolean;
  invoke?: InvokeFn;
}

type Result = { status: 'idle' } | ({ status: 'ok' } & SearchResults) | { status: 'failed' };

export function SearchPanel({ onOpen, showSystem = false, invoke = tauriInvoke }: Props) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result>({ status: 'idle' });

  useEffect(() => {
    if (query.trim() === '') {
      setResult({ status: 'idle' });
      return;
    }
    // 늦게 도착한 앞 질의의 답이 새 질의의 결과를 덮지 않게 한다.
    let live = true;
    const timer = setTimeout(() => {
      searchNotes(query, LIMIT, invoke).then(
        (r) => live && setResult({ status: 'ok', hits: r.hits, truncated: r.truncated }),
        () => live && setResult({ status: 'failed' }),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, invoke]);

  const hits = result.status === 'ok' ? (showSystem ? result.hits : result.hits.filter((h) => !isSystemPath(h.path))) : [];

  return (
    <section aria-label={t('search.label')}>
      <input
        type="search"
        role="searchbox"
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {result.status === 'failed' && <p role="alert">{t('search.error')}</p>}
      {result.status === 'ok' && hits.length === 0 && <p>{t('search.none')}</p>}
      {result.status === 'ok' && result.truncated && <p>{t('search.truncated', hits.length)}</p>}
      {hits.length > 0 && (
        <ul className="plain-list search-results">
          {hits.map((h) => (
            <li key={h.path.toLowerCase()}>
              <button type="button" onClick={() => onOpen(h.path)}>
                <strong>{h.title}</strong> <small>{h.path}</small>
                <br />
                <span>{h.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
