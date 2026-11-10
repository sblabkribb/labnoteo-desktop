import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readVaultBytes } from '../fs/vaultImage';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { extOf } from '../labnote/panel/treeIcons';
import { Icon } from '../ui/Icon';
import { isNumericColumn, parseCsv, type Delimiter, type ParsedCsv } from './csv';
import { decodeText, type TextEncodingName } from './decode';
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

type State =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; text: string; encoding: TextEncodingName; table: ParsedCsv };

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
 * CSV·TSV 보기(UI 재설계 Task 18). 바이트를 `vault_read_bytes`(50 MiB 상한)로 읽어 UTF-8, 아니면 EUC-KR 로 풀고(R6),
 * 표로 그린다: 머리 줄은 붙어 있고(sticky), 첫 열은 가로 스크롤에도 남고(.pinned), 숫자 열은 오른쪽 정렬 고정폭(.num),
 * 줄은 번갈아 칠한다(.alt). 2,000 줄이 넘으면 스크롤 둘레의 창만 그린다. "텍스트로 보기"는 원문을 그대로 보인다.
 * 상태 줄에 행×열, 인코딩, 구분자를 낸다.
 */
export function CsvViewer({ path }: { path: string }) {
  useLang();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [raw, setRaw] = useState(false);
  const [start, setStart] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    setRaw(false);
    setStart(0);
    readVaultBytes(path).then(
      (buf) => {
        if (!alive) return;
        const { text, encoding } = decodeText(buf);
        const table = parseCsv(text, extOf(path) === 'tsv' ? '\t' : undefined);
        setState({ kind: 'ready', text, encoding, table });
      },
      (e: unknown) => alive && setState({ kind: 'error', reason: readFailure(e, '50 MiB') }),
    );
    return () => {
      alive = false;
    };
  }, [path]);

  const table = state.kind === 'ready' ? state.table : undefined;
  const numeric = useMemo(() => (table ? table.header.map((_, i) => isNumericColumn(table.rows, i)) : []), [table]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const { table: tb, encoding } = state;
    publishViewerStatus(path, [t('viewer.csv.size', tb.rows.length, tb.header.length), ENCODING_LABEL[encoding], delimiterLabel(tb.delimiter)]);
  }, [path, state]);
  useEffect(() => () => clearViewerStatus(path), [path]);

  if (state.kind === 'error') return <FileCard path={path} kind="sheet" reason={state.reason} />;

  const onScroll = () => {
    if (!table || !scroller.current) return;
    const next = windowStart(scroller.current.scrollTop, table.rows.length);
    if (next !== start) setStart(next);
  };

  const total = table?.rows.length ?? 0;
  const end = Math.min(total, start + WINDOW_ROWS);
  const cols = table?.header.length ?? 0;
  const cellClass = (i: number) => [i === 0 ? 'pinned' : '', numeric[i] ? 'num' : ''].filter(Boolean).join(' ') || undefined;

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
        <span className="viewer-toolbar-gap" />
        <FileActions path={path} compact />
      </div>
      {state.kind === 'loading' && <p className="viewer-loading">{t('viewer.loading')}</p>}
      {state.kind === 'ready' && raw && <pre className="csv-raw">{state.text}</pre>}
      {state.kind === 'ready' && !raw && cols === 0 && <p className="viewer-loading">{t('viewer.csv.empty')}</p>}
      {table && !raw && cols > 0 && (
        <div className="csv-scroll" ref={scroller} onScroll={onScroll} tabIndex={0}>
          <table className="csv-table">
            <thead className="sticky">
              <tr>
                {table.header.map((h, i) => (
                  <th key={i} scope="col" className={cellClass(i)} title={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {start > 0 && <Spacer className="csv-spacer-before" rows={start} cols={cols} />}
              {table.rows.slice(start, end).map((row, k) => {
                const n = start + k;
                return (
                  <tr key={n} className={n % 2 === 1 ? 'alt' : undefined}>
                    {row.map((c, i) => (
                      <td key={i} className={cellClass(i)} title={c.length > 40 ? c : undefined}>
                        {c}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {end < total && <Spacer className="csv-spacer-after" rows={total - end} cols={cols} />}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
