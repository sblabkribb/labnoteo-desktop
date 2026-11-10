import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { t } from '../../i18n/t';
import { DialogFrame } from '../../labnote/host/DialogFrame';
import type { DialogSpec } from '../../labnote/host/dialogStore';
import { applySkinVars } from '../petStore';
import type { SkinUrls } from './useSkin';
import { SKIN_STATES, type SkinManifest, type SkinState } from './types';

/** 미리 보기 배율(정수: 흐리게 늘이지 않는다). */
const PREVIEW_SCALE = 2;

const browserUrls: SkinUrls = {
  create: (b) => URL.createObjectURL(b),
  revoke: (u) => URL.revokeObjectURL(u),
};

/**
 * 한 상태의 움직이는 미리 보기. 바이트로 `blob:` 주소를 만들고(CSP img-src blob:) 화면에서 빠지면 거둔다.
 * 그림 값은 CSSOM 변수로만 건다(style 속성 글자는 쓰지 않는다). 줄인 움직임이면 CSS 가 첫 칸에 멈춘다.
 */
export function SkinStateTile(props: { manifest: SkinManifest; state: SkinState; bytes: ArrayLike<number>; urls?: SkinUrls; label: string }) {
  const sprite = useRef<HTMLSpanElement>(null);
  const { manifest, state, bytes, urls = browserUrls } = props;
  useLayoutEffect(() => {
    const el = sprite.current;
    if (!el) return;
    const url = urls.create(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
    el.style.setProperty('--pet-scale', String(PREVIEW_SCALE));
    applySkinVars(el, manifest, state, () => url);
    return () => urls.revoke(url);
  }, [manifest, state, bytes, urls]);
  return (
    <figure className="pet-skin-tile">
      <span ref={sprite} className="pet-sprite" aria-hidden="true" />
      <figcaption>{props.label}</figcaption>
    </figure>
  );
}

/** 상태 이름(ko·en). 번역 키는 글자 그대로 둔다(카탈로그 검사가 키를 찾는다). */
export const STATE_LABEL: Record<SkinState, () => string> = {
  idle: () => t('skin.state.idle'),
  talk: () => t('skin.state.talk'),
  think: () => t('skin.state.think'),
  done: () => t('skin.state.done'),
};

/**
 * 스킨 가져오기 창(assistant 명세 §8.3, plan Task 17): Rust 가 검사해 임시 보관한 팩을 보여 준다.
 * 다른 사람이 만든 파일이라는 안내, 상태별 움직이는 미리 보기, 이름·만든 사람·라이선스·버전·설명(모두 글자로만;
 * React 가 이스케이프한다). "설치"는 'install' 로 끝나고, 부른 쪽이 따로 확인을 받은 뒤에야 설치한다. 닫으면(Esc, ×, 취소) undefined.
 */
export function SkinImportDialog(props: {
  spec: Extract<DialogSpec, { kind: 'skinImport' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { staged, urls } = props.spec;
  const { manifest } = staged;
  const id = useId();
  const install = useRef<HTMLButtonElement>(null);
  useEffect(() => install.current?.focus(), []);
  const facts: Array<[string, string]> = [
    [t('skin.import.name'), manifest.name],
    [t('skin.import.author'), manifest.author],
    [t('skin.import.licence'), manifest.licence],
    [t('skin.import.version'), manifest.version],
  ];
  if (manifest.description) facts.push([t('skin.import.description'), manifest.description]);
  return (
    <DialogFrame title={t('skin.import.title')} className="pet-skin-import" describedBy={`${id}-note`} onCancel={props.onCancel}>
      <p id={`${id}-note`} className="pet-skin-note">
        {t('skin.untrusted')}
      </p>
      <div className="pet-skin-preview" role="group" aria-label={t('skin.import.preview')}>
        {SKIN_STATES.map((st) => (
          <SkinStateTile key={st} manifest={manifest} state={st} bytes={staged.sheets[st]} urls={urls} label={STATE_LABEL[st]()} />
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
      <div className="dialog-actions">
        <button type="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        <button ref={install} type="button" className="primary" onClick={() => props.onDone('install')}>
          {t('skin.import.install')}
        </button>
      </div>
    </DialogFrame>
  );
}
