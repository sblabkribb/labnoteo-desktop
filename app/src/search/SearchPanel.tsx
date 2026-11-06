import { useEffect, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import { searchNotes, type SearchResults } from './indexApi';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const LIMIT = 50;
/** 타이핑이 멈추고 이만큼 지나야 묻는다: 글자마다 보관함을 훑지 않게. */
const DEBOUNCE_MS = 150;

interface Props {
  /** 결과를 고르면 그 노트의 vault-relative 경로로 부른다. */
  onOpen: (path: string) => void;
  /** 색인을 만드는 중이면 결과가 아직 덜 찼음을 알린다. */
  indexing?: boolean;
  /** 마지막 색인에서 읽지 못해 건너뛴 노트 수. 0 이 아니면 알린다. */
  skipped?: number;
  invoke?: InvokeFn;
}

type Result = { status: 'idle' } | ({ status: 'ok' } & SearchResults) | { status: 'failed' };

export function SearchPanel({ onOpen, indexing = false, skipped = 0, invoke = tauriInvoke }: Props) {
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
      {indexing && <p>{t('search.indexing')}</p>}
      {skipped > 0 && <p role="status">{t('search.skipped', skipped)}</p>}
      {result.status === 'failed' && <p role="alert">{t('search.error')}</p>}
      {result.status === 'ok' && result.hits.length === 0 && <p>{t('search.none')}</p>}
      {result.status === 'ok' && result.truncated && <p>{t('search.truncated', result.hits.length)}</p>}
      {result.status === 'ok' && result.hits.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {result.hits.map((h) => (
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
