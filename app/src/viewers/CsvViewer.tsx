import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readVaultBytes } from '../fs/vaultImage';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { extOf } from '../labnote/panel/treeIcons';
import { Icon } from '../ui/Icon';
import type { Delimiter } from './csv';
import { COL_WINDOW, ROW_CAP, loadCsv } from './csvLoad';
import type { TextEncodingName } from './decode';
import { FileActions, readFailure } from './fileActions';
import { FileCard } from './FileCard';
import { clearViewerStatus, publishViewerStatus } from './viewerStatus';

/** 한 줄의 높이(px). styles/viewers.css 의 `.csv-table tbody tr` 높이와 같아야 한다. */
export const ROW_PX = 28;
/** 한 번에 그리는 줄의 최대 수. 넘으면 스크롤 위치 둘레의 한 창만 그리고 위아래는 빈 줄(높이만)로 채운다. */
export const WINDOW_ROWS = 2000;
/** 창을 이만큼씩 옮긴다(스크롤마다 다시 그리지 않게). */
const WINDOW_STEP = 500;

/** 스크롤 위치 `top` 에서 그릴 창의 첫 줄. */
export function windowStart(top: number, total: number): number {
  if (total <= WINDOW_ROWS) return 0;
  const first = Math.floor(top / ROW_PX);
  const start = Math.floor(first / WINDOW_STEP) * WINDOW_STEP - WINDOW_STEP;
  return Math.max(0, Math.min(start, total - WINDOW_ROWS));
}

const ENCODING_LABEL: Record<TextEncodingName, string> = { 'utf-8': 'UTF-8', 'euc-kr': 'EUC-KR' };
/** 구분자의 이름. */
function delimiterLabel(d: Delimiter): string {
  if (d === '\t') return t('viewer.delim.tab');
  return d === ';' ? t('viewer.delim.semicolon') : t('viewer.delim.comma');
}

/** 큰 수는 천 단위 쉼표로. */
const count = (n: number) => n.toLocaleString('en-US');

interface Table {
  header: string[];
  delimiter: Delimiter;
  encoding: TextEncodingName;
  raw: string;
  rawCapped: boolean;
  /** 담아 둔 줄(최대 ROW_CAP). */
  rows: string[][];
  /** 가장 넓은 줄의 칸 수(머리 줄 포함). */
  width: number;
  numeric: boolean[];
  /** 다 읽었으면 전체 줄 수. */
  total?: number;
}

type State = { kind: 'loading' } | { kind: 'error'; reason: string } | { kind: 'ready'; table: Table };

const widest = (rows: readonly (readonly string[])[], start: number) => rows.reduce((w, r) => Math.max(w, r.length), start);

/** 높이만 가진 빈 줄. 높이는 CSSOM 으로(`--csv-pad`), style 속성을 마크업에 쓰지 않는다. */
function Spacer({ className, rows, cols }: { className: string; rows: number; cols: number }) {
  const ref = useRef<HTMLTableRowElement>(null);
  useLayoutEffect(() => {
    ref.current?.style.setProperty('--csv-pad', `${rows * ROW_PX}px`);
  }, [rows]);
  return (
    <tr ref={ref} className={`csv-spacer ${className}`} aria-hidden="true">
      <td colSpan={Math.max(1, cols)} />
    </tr>
  );
}

/**
 * CSV·TSV 보기(UI 재설계 Task 18, Task 14). 바이트를 `vault_read_bytes`(50 MiB 상한)로 읽어 Worker 로 넘기고
 * (csvLoad.ts), 머리 줄과 첫 줄들이 오면 바로 그린다. 표에는 5,000 줄까지만 담고(넘으면 전체 줄 수를 알린다), 열은 50 개씩
 * 앞·뒤 단추로 넘긴다. 머리 줄은 붙어 있고(sticky), 첫 열은 가로 스크롤에도 남고(.pinned), 숫자 열은 오른쪽 정렬
 * 고정폭(.num), 줄은 번갈아 칠한다(.alt). 2,000 줄이 넘으면 스크롤 둘레의 창만 그린다. "텍스트로 보기"는 원문의 앞부분을
 * 그대로 보인다. 상태 줄에 행×열(전체 줄 수), 인코딩, 구분자를 낸다.
 */
export function CsvViewer({ path }: { path: string }) {
  useLang();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [raw, setRaw] = useState(false);
  const [start, setStart] = useState(0);
  const [colStart, setColStart] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setState({ kind: 'loading' });
    setRaw(false);
    setStart(0);
    setColStart(0);
    readVaultBytes(path).then(
      (buf) => {
        if (ctl.signal.aborted) return;
        loadCsv(new Uint8Array(buf), {
          hint: extOf(path) === 'tsv' ? '\t' : undefined,
          signal: ctl.signal,
          onHeader: (h) =>
            setState({ kind: 'ready', table: { ...h, rows: [], width: h.header.length, numeric: [] } }),
          onRows: (rows, done, total, numeric) =>
            setState((s) => {
              if (s.kind !== 'ready') return s;
              const tb = s.table;
              return {
                kind: 'ready',
                table: {
                  ...tb,
                  rows: rows.length > 0 ? tb.rows.concat(rows) : tb.rows,
                  width: widest(rows, tb.width),
                  numeric: numeric ?? tb.numeric,
                  total: done ? total : tb.total,
                },
              };
            }),
          onError: (message) => setState({ kind: 'error', reason: t('viewer.readFailed', message) }),
        });
      },
      (e: unknown) => !ctl.signal.aborted && setState({ kind: 'error', reason: readFailure(e, '50 MiB') }),
    );
    return () => ctl.abort();
  }, [path]);

  const table = state.kind === 'ready' ? state.table : undefined;

  useEffect(() => {
    if (!table) return;
    publishViewerStatus(path, [
      t('viewer.csv.size', table.total ?? table.rows.length, table.width),
      ENCODING_LABEL[table.encoding],
      delimiterLabel(table.delimiter),
    ]);
  }, [path, table]);
  useEffect(() => () => clearViewerStatus(path), [path]);

  if (state.kind === 'error') return <FileCard path={path} kind="sheet" reason={state.reason} />;

  const onScroll = () => {
    if (!table || !scroller.current) return;
    const next = windowStart(scroller.current.scrollTop, table.rows.length);
    if (next !== start) setStart(next);
  };

  const kept = table?.rows.length ?? 0;
  const end = Math.min(kept, start + WINDOW_ROWS);
  const cols = table?.width ?? 0;
  const colEnd = Math.min(cols, colStart + COL_WINDOW);
  const shown = colEnd - colStart;
  const colIdx = Array.from({ length: Math.max(0, shown) }, (_, k) => colStart + k);
  const numeric = table?.numeric ?? [];
  const cellClass = (i: number) => [i === 0 ? 'pinned' : '', numeric[i] ? 'num' : ''].filter(Boolean).join(' ') || undefined;
  const capped = table?.total !== undefined && table.total > ROW_CAP;

  return (
    <section className="csv-viewer" aria-label={t('viewer.csv.label')}>
      <div className="viewer-toolbar" role="toolbar" aria-label={t('viewer.toolbar')}>
        <button
          type="button"
          className="ibtn"
          aria-label={t('viewer.csv.asText')}
          title={t('viewer.csv.asText')}
          aria-pressed={raw}
          disabled={state.kind !== 'ready'}
          onClick={() => setRaw((r) => !r)}
        >
          <Icon name="file-text" />
        </button>
        {table && !raw && cols > COL_WINDOW && (
          <>
            <button
              type="button"
              className="ibtn"
              aria-label={t('viewer.csv.prevCols')}
              title={t('viewer.csv.prevCols')}
              disabled={colStart === 0}
              onClick={() => setColStart((c) => Math.max(0, c - COL_WINDOW))}
            >
              <Icon name="arrow-left" />
            </button>
            <span className="csv-cols">{t('viewer.csv.cols', colStart + 1, colEnd, cols)}</span>
            <button
              type="button"
              className="ibtn"
              aria-label={t('viewer.csv.nextCols')}
              title={t('viewer.csv.nextCols')}
              disabled={colEnd >= cols}
              onClick={() => setColStart((c) => Math.min(c + COL_WINDOW, cols - 1))}
            >
              <Icon name="arrow-right" />
            </button>
          </>
        )}
        <span className="viewer-toolbar-gap" />
        <FileActions path={path} compact />
      </div>
      {state.kind === 'loading' && <p className="viewer-loading">{t('viewer.loading')}</p>}
      {table && raw && (
        <>
          {table.rawCapped && <p className="csv-note">{t('viewer.csv.rawCapped')}</p>}
          <pre className="csv-raw">{table.raw}</pre>
        </>
      )}
      {table && !raw && cols === 0 && <p className="viewer-loading">{t('viewer.csv.empty')}</p>}
      {table && !raw && capped && <p className="csv-note">{t('viewer.csv.capped', count(ROW_CAP), count(table.total!))}</p>}
      {table && !raw && cols > 0 && (
        <div className="csv-scroll" ref={scroller} onScroll={onScroll} tabIndex={0}>
          <table className="csv-table">
            <thead className="sticky">
              <tr>
                {colIdx.map((i) => {
                  const h = table.header[i] ?? '';
                  return (
                    <th key={i} scope="col" className={cellClass(i)} title={h}>
                      {h}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {start > 0 && <Spacer className="csv-spacer-before" rows={start} cols={shown} />}
              {table.rows.slice(start, end).map((row, k) => {
                const n = start + k;
                return (
                  <tr key={n} className={n % 2 === 1 ? 'alt' : undefined}>
                    {colIdx.map((i) => {
                      const c = row[i] ?? '';
                      return (
                        <td key={i} className={cellClass(i)} title={c.length > 40 ? c : undefined}>
                          {c}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {end < kept && <Spacer className="csv-spacer-after" rows={kept - end} cols={shown} />}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
