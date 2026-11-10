import { useEffect, useId, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../../i18n/t';
import { DialogFrame } from '../../labnote/host/DialogFrame';
import type { DialogSpec } from '../../labnote/host/dialogStore';
import { STATE_LABEL, SkinStateTile } from './ImportDialog';
import {
  DEFAULT_GALLERY_URL,
  cleanGalleryText,
  fetchGalleryIndex,
  fetchGallerySkin,
  formatSize,
  type GalleryEntry,
  type GalleryPreview,
} from './gallery';
import { discardStagedSkin, skinErrorText } from './store';
import { SKIN_STATES } from './types';

type ListState = { kind: 'loading' } | { kind: 'ready'; skins: GalleryEntry[] } | { kind: 'error'; message: string; url: string };

/**
 * 스킨 갤러리 창(assistant 명세 §8.5, plan Task 19). 열리면 목록을 한 번 읽는다(다시 시도하지 않는다; 못 읽으면 까닭과 주소).
 * 항목마다 이름·만든 사람·라이선스·크기와 "미리 보기". 미리 보기는 Rust 가 내려받아 검사한 팩의 움직이는 그림과 스킨 파일의
 * 라이선스를 보인다. 라이선스가 목록과 다르면 설치 단추를 끄고 까닭을 적는다. "설치"는 미리 보기를 돌려줄 뿐이고, 부른 쪽이
 * 따로 확인을 받은 뒤에야 설치한다. 갤러리 글은 모두 글자로만 보인다(React 가 이스케이프하고 제어·방향 문자는 지운다).
 * 닫으면 임시 보관한 팩을 버린다.
 */
export function SkinGalleryDialog(props: {
  spec: Extract<DialogSpec, { kind: 'skinGallery' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { deps } = props.spec;
  const invoke = deps.invoke ?? tauriInvoke;
  const id = useId();
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [preview, setPreview] = useState<GalleryPreview | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState('');
  /** 지금 임시 보관한 팩(닫거나 다른 것을 미리 볼 때 버린다). 설치로 넘기면 비운다. */
  const staged = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchGalleryIndex(invoke).then(
      (l) => live && setList({ kind: 'ready', skins: l.skins }),
      async (e) => {
        const url = await (deps.galleryUrl?.() ?? Promise.resolve(DEFAULT_GALLERY_URL)).catch(() => DEFAULT_GALLERY_URL);
        if (live) setList({ kind: 'error', message: skinErrorText(e), url });
      },
    );
    return () => {
      live = false;
      const left = staged.current;
      staged.current = null;
      if (left) void discardStagedSkin(left, invoke).catch(() => undefined);
    };
    // Read once when the dialog opens: no retry loop, no background refresh.
  }, []);

  const show = async (entry: GalleryEntry) => {
    setBusy(entry.id);
    setStatus(t('gallery.downloading', cleanGalleryText(entry.name)));
    try {
      const p = await fetchGallerySkin(entry.id, invoke);
      const old = staged.current;
      staged.current = p.stagingId;
      if (old && old !== p.stagingId) void discardStagedSkin(old, invoke).catch(() => undefined);
      setPreview(p);
      setStatus('');
    } catch (e) {
      setStatus(t('gallery.downloadFailed', skinErrorText(e)));
    } finally {
      setBusy(undefined);
    }
  };

  const install = () => {
    if (!preview?.stagingId || !preview.licenceMatches) return;
    // 설치 흐름이 이 팩을 넘겨받는다: 닫힐 때 버리지 않는다.
    staged.current = null;
    props.onDone(preview);
  };

  return (
    <DialogFrame title={t('gallery.title')} className="pet-skin-gallery" describedBy={`${id}-note`} onCancel={props.onCancel}>
      <p id={`${id}-note`} className="pet-skin-note">
        {t('skin.untrusted')}
      </p>
      {list.kind === 'loading' && <p className="pet-gallery-empty">{t('gallery.loading')}</p>}
      {list.kind === 'error' && (
        <div className="pet-gallery-error" role="alert">
          <p>{list.message}</p>
          <p className="pet-gallery-url">{list.url}</p>
        </div>
      )}
      {list.kind === 'ready' && list.skins.length === 0 && <p className="pet-gallery-empty">{t('gallery.empty')}</p>}
      {list.kind === 'ready' && list.skins.length > 0 && (
        <ul className="pet-gallery-list" aria-label={t('gallery.list')}>
          {list.skins.map((s) => {
            const name = cleanGalleryText(s.name);
            return (
              <li key={s.id} className={preview?.manifest.id === s.id ? 'pet-gallery-item is-current' : 'pet-gallery-item'}>
                <div className="pet-gallery-text">
                  <strong>{name}</strong>
                  <span className="pet-gallery-meta">
                    {t('gallery.meta', cleanGalleryText(s.author), cleanGalleryText(s.licence), formatSize(s.size))}
                  </span>
                  {s.description && <span className="pet-gallery-desc">{cleanGalleryText(s.description)}</span>}
                </div>
                <button type="button" className="btn" disabled={busy !== undefined} aria-label={t('gallery.previewOf', name)} onClick={() => void show(s)}>
                  {t('gallery.preview')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p role="status" className="setting-status">
        {status}
      </p>
      {preview && <PreviewPane preview={preview} urls={deps.urls} />}
      <div className="dialog-actions">
        <button type="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        {preview && (
          <button type="button" className="primary" disabled={!preview.stagingId || !preview.licenceMatches} onClick={install}>
            {t('skin.import.install')}
          </button>
        )}
      </div>
    </DialogFrame>
  );
}

/** 내려받은 팩의 움직이는 미리 보기와 사실들(스킨 파일의 라이선스 포함). 라이선스가 목록과 다르면 까닭을 적는다. */
function PreviewPane(props: { preview: GalleryPreview; urls?: Parameters<typeof SkinStateTile>[0]['urls'] }) {
  const { manifest, sheets } = props.preview;
  const facts: Array<[string, string]> = [
    [t('skin.import.name'), cleanGalleryText(manifest.name)],
    [t('skin.import.author'), cleanGalleryText(manifest.author)],
    [t('skin.import.licence'), cleanGalleryText(manifest.licence)],
    [t('skin.import.version'), cleanGalleryText(manifest.version)],
  ];
  if (manifest.description) facts.push([t('skin.import.description'), cleanGalleryText(manifest.description)]);
  return (
    <section className="pet-gallery-preview" aria-label={t('skin.import.preview')}>
      <div className="pet-skin-preview" role="group" aria-label={t('skin.import.preview')}>
        {SKIN_STATES.map((st) => (
          <SkinStateTile key={st} manifest={manifest} state={st} bytes={sheets[st]} urls={props.urls} label={STATE_LABEL[st]()} />
        ))}
      </div>
      <dl className="pet-skin-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {!props.preview.licenceMatches && (
        <p className="pet-gallery-mismatch" role="note">
          {t('gallery.licenceMismatch', cleanGalleryText(props.preview.indexLicence), cleanGalleryText(manifest.licence))}
        </p>
      )}
    </section>
  );
}
