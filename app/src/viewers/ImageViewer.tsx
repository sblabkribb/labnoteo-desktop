import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MIME, extOf } from '../editor/live/imagePath';
import { readVaultImage } from '../fs/vaultImage';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from '../ui/Icon';
import { FileActions, readFailure } from './fileActions';
import { FileCard } from './FileCard';
import { clearViewerStatus, formatBytes, publishViewerStatus } from './viewerStatus';

/** 배율 단계(1 = 실제 크기). */
export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

/** 지금 배율 `z` 에서 한 단계 위(`dir` 1) 또는 아래(-1). 끝이면 그대로. */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? ZOOM_STEPS[0];
}

type Zoom = 'fit' | number;

type State =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; url: string; bytes: number };

/**
 * 그림 보기(UI 재설계 Task 18). 바이트는 `vault_read_image`(20 MiB 상한)로 읽어 blob: URL 로 보인다(CSP 는 img-src 에 blob: 만
 * 열었다. SVG 도 `<img src=blob:>` 로만 그려 스크립트가 돌지 않는다). 투명한 곳은 체커보드로 보인다.
 * 배율은 기본이 창에 맞춤(fit, 작은 그림은 키우지 않는다)이고, 수로 바꾸면 `--zoom` 을 CSSOM(setProperty)으로 적는다.
 * 키: + / = 확대, - 축소, 0 맞춤, 1 실제 크기. 상태 줄에 픽셀 크기, 바이트, 배율을 낸다.
 */
export function ImageViewer({ path }: { path: string }) {
  useLang();
  const name = path.slice(path.lastIndexOf('/') + 1);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [size, setSize] = useState<{ w: number; h: number }>();
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    setState({ kind: 'loading' });
    setZoom('fit');
    setSize(undefined);
    readVaultImage(path).then(
      (buf) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([buf], { type: MIME[extOf(path)] ?? 'application/octet-stream' }));
        setState({ kind: 'ready', url, bytes: buf.byteLength });
      },
      (e: unknown) => alive && setState({ kind: 'error', reason: readFailure(e, '20 MiB') }),
    );
    return () => {
      alive = false;
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [path]);

  // 배율은 CSSOM 으로만(style 속성을 마크업에 쓰지 않는다): 맞춤이면 지운다
  useLayoutEffect(() => {
    const el = img.current;
    if (!el) return;
    if (zoom === 'fit') el.style.removeProperty('--zoom');
    else el.style.setProperty('--zoom', String(zoom));
  }, [zoom, state]);

  const zoomText = zoom === 'fit' ? t('viewer.fitShort') : `${Math.round(zoom * 100)}%`;
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const items = [...(size ? [t('viewer.dims', size.w, size.h)] : []), formatBytes(state.bytes, t), zoomText];
    publishViewerStatus(path, items);
  }, [path, state, size, zoomText]);
  useEffect(() => () => clearViewerStatus(path), [path]);

  /** 맞춤 상태에서 지금 보이는 배율(그린 폭 / 실제 폭). 알 수 없으면 1. */
  const current = (): number => {
    if (zoom !== 'fit') return zoom;
    const el = img.current;
    return el && el.naturalWidth > 0 && el.clientWidth > 0 ? el.clientWidth / el.naturalWidth : 1;
  };
  const zoomBy = (dir: 1 | -1) => setZoom(stepZoom(current(), dir));

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomBy(1);
    else if (e.key === '-' || e.key === '_') zoomBy(-1);
    else if (e.key === '0') setZoom('fit');
    else if (e.key === '1') setZoom(1);
    else return;
    e.preventDefault();
  };

  if (state.kind === 'error') return <FileCard path={path} kind="image" reason={state.reason} />;
  return (
    <section className="image-viewer" aria-label={t('viewer.image.label')} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="viewer-toolbar" role="toolbar" aria-label={t('viewer.toolbar')}>
        <button type="button" className="ibtn" aria-label={t('viewer.zoomOut')} title={t('viewer.zoomOut')} onClick={() => zoomBy(-1)}>
          <Icon name="zoom-out" />
        </button>
        <span className="viewer-zoom" aria-live="polite">
          {zoomText}
        </span>
        <button type="button" className="ibtn" aria-label={t('viewer.zoomIn')} title={t('viewer.zoomIn')} onClick={() => zoomBy(1)}>
          <Icon name="zoom-in" />
        </button>
        <button
          type="button"
          className="ibtn"
          aria-label={t('viewer.fit')}
          title={t('viewer.fit')}
          aria-pressed={zoom === 'fit'}
          onClick={() => setZoom('fit')}
        >
          <Icon name="maximize" />
        </button>
        <button
          type="button"
          className="ibtn viewer-actual"
          aria-label={t('viewer.actual')}
          title={t('viewer.actual')}
          aria-pressed={zoom === 1}
          onClick={() => setZoom(1)}
        >
          1:1
        </button>
        <span className="viewer-toolbar-gap" />
        <FileActions path={path} compact />
      </div>
      <div className={zoom === 'fit' ? 'image-stage checker fit' : 'image-stage checker'}>
        {state.kind === 'loading' ? (
          <p className="viewer-loading">{t('viewer.loading')}</p>
        ) : (
          <img
            ref={img}
            className="image-viewer-img"
            src={state.url}
            alt={name}
            data-zoom={zoom === 'fit' ? 'fit' : 'scale'}
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        )}
      </div>
    </section>
  );
}
