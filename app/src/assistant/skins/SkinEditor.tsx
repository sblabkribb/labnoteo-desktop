import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../../integrations/netIpc';
import { t } from '../../i18n/t';
import { DialogFrame } from '../../labnote/host/DialogFrame';
import { openDialog, type DialogSpec } from '../../labnote/host/dialogStore';
import { notify as toast } from '../../labnote/host/toastStore';
import { layoutStore } from '../../ui/layoutStore';
import { SelectField } from '../../ui/SelectField';
import { STATE_LABEL } from './ImportDialog';
import {
  AUTHOR_MAX,
  DESCRIPTION_MAX,
  FPS_MAX,
  FRAMES_MAX,
  FRAME_MAX,
  FRAME_MIN,
  NAME_MAX,
  buildSkin,
  draftErrors,
  emptyEditorState,
  exportStagedSkin,
  pickSheet,
  toDraft,
  withSheet,
  type DraftErrors,
  type DraftField,
  type PickedSheet,
  type SkinEditorState,
} from './skinDraft';
import { discardStagedSkin, installSkin, skinErrorText, toSkinError } from './store';
import { SKIN_LICENCES, SKIN_STATES, type SkinManifest, type SkinState } from './types';
import type { SkinUrls } from './useSkin';

/** 미리 보기 배율(정수: 흐리게 늘이지 않는다). */
const PREVIEW_SCALE = 2;

const browserUrls: SkinUrls = {
  create: (b) => URL.createObjectURL(b),
  revoke: (u) => URL.revokeObjectURL(u),
};

export interface SkinEditorDeps {
  invoke?: InvokeFn;
  /** 미리 보기의 blob 주소(테스트). */
  urls?: SkinUrls;
  notify?: (kind: 'info' | 'warn', message: string) => void;
  /** 설치한 스킨으로 바꾼다(기본: 이 PC 의 ui.json pet.skin). */
  setSkin?: (id: string) => void;
  /** 줄인 움직임(기본: html[data-reduced-motion] 또는 미디어 쿼리). 그러면 미리 보기가 멈추고 칸 고르기 막대가 생긴다. */
  reducedMotion?: boolean;
}

/** 내 스킨 만들기 창을 연다. 설치한 스킨의 manifest, 닫으면 undefined. */
export function openSkinEditor(deps: SkinEditorDeps = {}): Promise<SkinManifest | undefined> {
  return openDialog<SkinManifest | undefined>({ kind: 'skinEditor', deps }, undefined);
}

function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-reduced-motion')) return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const clamp = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : min);

/**
 * 한 상태의 살아 있는 미리 보기: 도우미와 같은 `.pet-sprite` 를 쓴다. 바이트로 `blob:` 주소를 만들고(CSP img-src blob:)
 * 그림이 바뀌거나 창이 닫히면 거둔다. 값은 CSSOM 변수로만 건다(style 속성 글자는 쓰지 않는다). 줄인 움직임이면 CSS 가 멈추고
 * `--pet-frame` 칸이 보인다.
 */
function SheetPreview(props: {
  sheet: PickedSheet;
  frame: { width: number; height: number };
  frames: number;
  fps: number;
  step: number;
  urls: SkinUrls;
}) {
  const sprite = useRef<HTMLSpanElement>(null);
  const { sheet, urls } = props;
  useLayoutEffect(() => {
    const el = sprite.current;
    if (!el) return;
    const url = urls.create(new Blob([Uint8Array.from(sheet.bytes)], { type: 'image/png' }));
    el.style.setProperty('--pet-scale', String(PREVIEW_SCALE));
    el.style.setProperty('--pet-sheet', `url("${url}")`);
    return () => urls.revoke(url);
  }, [sheet, urls]);
  const w = clamp(props.frame.width, FRAME_MIN, FRAME_MAX);
  const h = clamp(props.frame.height, FRAME_MIN, FRAME_MAX);
  const frames = clamp(props.frames, 1, FRAMES_MAX);
  const fps = clamp(props.fps, 1, FPS_MAX);
  const step = clamp(props.step, 0, frames - 1);
  useLayoutEffect(() => {
    const el = sprite.current;
    if (!el) return;
    el.style.setProperty('--pet-w', `${w}px`);
    el.style.setProperty('--pet-h', `${h}px`);
    el.style.setProperty('--pet-frames', String(frames));
    el.style.setProperty('--pet-dur', `${Math.round((frames / fps) * 1000)}ms`);
    el.style.setProperty('--pet-frame', String(step));
  }, [w, h, frames, fps, step]);
  return (
    <span className="pet-skin-editor-preview">
      <span ref={sprite} className="pet-sprite" aria-hidden="true" />
    </span>
  );
}

/** 칸 아래의 짧은 안내. 보일 때만 그린다. */
function FieldError(props: { id: string; text?: string }) {
  return props.text ? (
    <p id={props.id} className="prompt-error pet-skin-editor-error">
      {props.text}
    </p>
  ) : null;
}

/**
 * 내 스킨 만들기 창(assistant 명세 §8.4, plan Task 18): 이름·만든 사람·라이선스(허용 목록에서 고르기)·설명, 한 칸 너비·높이,
 * 상태마다 "PNG 고르기"(Rust 열기 창)·칸 수(1–16)·초당 칸(1–24)과 살아 있는 미리 보기. 잘못된 곳은 그 칸 아래에 바로 보인다.
 * "내보내기"는 Rust 가 팩을 만들어 검사한 뒤 저장 창으로 쓰고, "설치"는 같은 검사를 거쳐 바로 설치하고 그 스킨으로 바꾼다.
 * 같은 이름의 스킨이 있으면 창 안에서 바꿀지 묻는다(창 위에 다른 창을 줄 세우지 않는다).
 */
export function SkinEditorDialog(props: {
  spec: Extract<DialogSpec, { kind: 'skinEditor' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const deps = props.spec.deps;
  const invoke = deps.invoke ?? tauriInvoke;
  const urls = deps.urls ?? browserUrls;
  const notify = deps.notify ?? toast;
  const setSkin = deps.setSkin ?? ((id: string) => layoutStore.setPet({ skin: id }));
  const [reduced] = useState(() => deps.reducedMotion ?? prefersReducedMotion());
  const id = useId();
  const [state, setState] = useState<SkinEditorState>(emptyEditorState);
  const [touched, setTouched] = useState<ReadonlySet<DraftField>>(new Set());
  const [tried, setTried] = useState(false);
  const [steps, setSteps] = useState<Record<SkinState, number>>({ idle: 0, talk: 0, think: 0, done: 0 });
  const [pickError, setPickError] = useState<Partial<Record<SkinState, string>>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState<{ stagingId: string; name: string } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const live = useRef(true);
  // 버리지 않은 임시 보관(바꾸기를 묻는 중): 창이 닫히면 버린다.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    nameInput.current?.focus();
    live.current = true;
    return () => {
      live.current = false;
      if (pending.current) void discardStagedSkin(pending.current, invoke).catch(() => undefined);
    };
    // Mount only.
  }, []);
  // 바꾸기를 물으면 그 단추로 초점을 옮긴다(만드는 중에는 단추가 꺼져 있으니 끝난 뒤에).
  useEffect(() => {
    if (replace && !busy) replaceButton.current?.focus();
  }, [replace, busy]);

  const errors: DraftErrors = draftErrors(state);
  const shown = (f: DraftField): string | undefined => (tried || touched.has(f) ? errors[f] : undefined);
  const touch = (...f: DraftField[]) =>
    setTouched((prev) => {
      const next = new Set(prev);
      for (const x of f) next.add(x);
      return next;
    });
  const fid = (f: string) => `${id}-${f.replace('.', '-')}`;
  const errId = (f: string) => `${fid(f)}-err`;
  const invalid = (f: DraftField) => (shown(f) ? true : undefined);
  const describedBy = (f: DraftField, extra?: string) => [extra, shown(f) ? errId(f) : ''].filter(Boolean).join(' ') || undefined;

  const update = (patch: Partial<SkinEditorState>, ...f: DraftField[]) => {
    setState((s) => ({ ...s, ...patch }));
    touch(...f);
    setStatus('');
  };
  const updateState = (st: SkinState, patch: { frames?: number; fps?: number }, f: DraftField) => {
    setState((s) => ({ ...s, states: { ...s.states, [st]: { ...s.states[st], ...patch } } }));
    touch(f, `${st}.sheet`);
    setStatus('');
  };

  const pick = async (st: SkinState) => {
    setPickError((p) => ({ ...p, [st]: undefined }));
    try {
      const sheet = await pickSheet(invoke);
      if (!live.current || !sheet) return;
      setState((s) => withSheet(s, st, sheet));
      touch(`${st}.sheet`, `${st}.frames`);
      setStatus('');
    } catch (e) {
      if (live.current) setPickError((p) => ({ ...p, [st]: t('skin.editor.pickFailed', skinErrorText(e)) }));
    }
  };

  /** 처음 잘못된 칸으로 초점을 옮긴다. */
  const focusFirstError = (errs: DraftErrors) => {
    const order: DraftField[] = ['name', 'author', 'licence', 'description', 'frame'];
    for (const st of SKIN_STATES) order.push(`${st}.sheet`, `${st}.frames`, `${st}.fps`);
    const first = order.find((f) => errs[f]);
    if (!first) return;
    const target = first === 'frame' ? fid('frame-width') : first.endsWith('.sheet') ? fid(`${first}-pick`) : fid(first);
    document.getElementById(target)?.focus();
  };

  const drop = (stagingId: string) => {
    if (pending.current === stagingId) pending.current = null;
    return discardStagedSkin(stagingId, invoke).catch(() => undefined);
  };

  const install = async (stagingId: string, name: string, replaceIt: boolean) => {
    try {
      const m = await installSkin(stagingId, replaceIt, invoke);
      pending.current = null;
      setSkin(m.id);
      notify('info', t('skin.installed', m.name));
      props.onDone(m);
    } catch (e) {
      if (!replaceIt && toSkinError(e).kind === 'exists') {
        pending.current = stagingId;
        if (live.current) setReplace({ stagingId, name });
        return;
      }
      await drop(stagingId);
      if (live.current) setStatus(t('skin.installFailed', skinErrorText(e)));
    }
  };

  const act = async (what: 'install' | 'export') => {
    const draft = toDraft(state);
    if (!draft) {
      setTried(true);
      setStatus(t('skin.editor.fixErrors'));
      focusFirstError(errors);
      return;
    }
    if (replace) {
      await drop(replace.stagingId);
      setReplace(null);
    }
    setBusy(true);
    setStatus('');
    try {
      let staged;
      try {
        staged = await buildSkin(draft, invoke);
      } catch (e) {
        if (live.current) setStatus(t('skin.editor.buildFailed', skinErrorText(e)));
        return;
      }
      if (what === 'install') {
        await install(staged.stagingId, staged.manifest.name, false);
        return;
      }
      try {
        if (await exportStagedSkin(staged.stagingId, invoke)) notify('info', t('skin.exported'));
      } catch (e) {
        if (live.current) setStatus(t('skin.exportFailed', skinErrorText(e)));
      } finally {
        await drop(staged.stagingId);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const runReplace = async () => {
    if (!replace) return;
    const r = replace;
    setReplace(null);
    setBusy(true);
    try {
      await install(r.stagingId, r.name, true);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const labelFor = (label: string, st: SkinState) => t('skin.editor.labelFor', label, STATE_LABEL[st]());

  return (
    <DialogFrame title={t('skin.editor.title')} className="pet-skin-editor" describedBy={`${id}-intro`} onCancel={props.onCancel}>
      <div className="pet-skin-editor-body">
        <p id={`${id}-intro`} className="prompt-hint">
          {t('skin.editor.intro')}
        </p>
        <div className="pet-skin-editor-fields">
          <label htmlFor={fid('name')}>{t('skin.import.name')}</label>
          <div>
            <input
              ref={nameInput}
              id={fid('name')}
              type="text"
              autoComplete="off"
              maxLength={NAME_MAX}
              aria-invalid={invalid('name')}
              aria-describedby={describedBy('name')}
              value={state.name}
              onChange={(e) => update({ name: e.target.value })}
              onBlur={() => touch('name')}
            />
            <FieldError id={errId('name')} text={shown('name')} />
          </div>
          <label htmlFor={fid('author')}>{t('skin.import.author')}</label>
          <div>
            <input
              id={fid('author')}
              type="text"
              autoComplete="off"
              maxLength={AUTHOR_MAX}
              aria-invalid={invalid('author')}
              aria-describedby={describedBy('author')}
              value={state.author}
              onChange={(e) => update({ author: e.target.value })}
              onBlur={() => touch('author')}
            />
            <FieldError id={errId('author')} text={shown('author')} />
          </div>
          <label htmlFor={fid('licence')}>{t('skin.import.licence')}</label>
          <div>
            <SelectField
              id={fid('licence')}
              aria-invalid={invalid('licence')}
              aria-describedby={describedBy('licence')}
              value={state.licence}
              onChange={(e) => update({ licence: e.currentTarget.value as SkinEditorState['licence'] }, 'licence')}
              onBlur={() => touch('licence')}
            >
              <option value="">{t('skin.editor.licencePick')}</option>
              {SKIN_LICENCES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </SelectField>
            <FieldError id={errId('licence')} text={shown('licence')} />
          </div>
          <label htmlFor={fid('description')}>{t('skin.import.description')}</label>
          <div>
            <input
              id={fid('description')}
              type="text"
              autoComplete="off"
              maxLength={DESCRIPTION_MAX}
              aria-invalid={invalid('description')}
              aria-describedby={describedBy('description')}
              value={state.description}
              onChange={(e) => update({ description: e.target.value }, 'description')}
            />
            <FieldError id={errId('description')} text={shown('description')} />
          </div>
          <span id={fid('frame-label')}>{t('skin.editor.frame')}</span>
          <div>
            <div className="pet-skin-editor-numbers" role="group" aria-labelledby={fid('frame-label')}>
              <label>
                <span>{t('skin.editor.frameWidth')}</span>
                <input
                  id={fid('frame-width')}
                  type="number"
                  min={FRAME_MIN}
                  max={FRAME_MAX}
                  step={1}
                  aria-invalid={invalid('frame')}
                  aria-describedby={describedBy('frame')}
                  value={Number.isNaN(state.frame.width) ? '' : state.frame.width}
                  onChange={(e) => update({ frame: { ...state.frame, width: num(e.target.value) } }, 'frame')}
                />
              </label>
              <label>
                <span>{t('skin.editor.frameHeight')}</span>
                <input
                  id={fid('frame-height')}
                  type="number"
                  min={FRAME_MIN}
                  max={FRAME_MAX}
                  step={1}
                  aria-invalid={invalid('frame')}
                  aria-describedby={describedBy('frame')}
                  value={Number.isNaN(state.frame.height) ? '' : state.frame.height}
                  onChange={(e) => update({ frame: { ...state.frame, height: num(e.target.value) } }, 'frame')}
                />
              </label>
            </div>
            <FieldError id={errId('frame')} text={shown('frame')} />
          </div>
        </div>

        <div className="pet-skin-editor-states">
          {SKIN_STATES.map((st) => {
            const spec = state.states[st];
            const label = STATE_LABEL[st]();
            const sheetErr = pickError[st] ?? shown(`${st}.sheet`);
            return (
              <fieldset key={st} className="pet-skin-editor-state">
                <legend>{label}</legend>
                {spec.sheet ? (
                  <SheetPreview sheet={spec.sheet} frame={state.frame} frames={spec.frames} fps={spec.fps} step={steps[st]} urls={urls} />
                ) : (
                  <span className="pet-skin-editor-preview pet-skin-editor-empty">{t('skin.editor.noSheet')}</span>
                )}
                <div className="pet-skin-editor-pick">
                  <button
                    id={fid(`${st}.sheet-pick`)}
                    type="button"
                    className="btn"
                    disabled={busy}
                    aria-label={labelFor(t('skin.editor.pick'), st)}
                    aria-invalid={sheetErr ? true : undefined}
                    aria-describedby={sheetErr ? errId(`${st}.sheet`) : undefined}
                    onClick={() => void pick(st)}
                  >
                    {t('skin.editor.pick')}
                  </button>
                  {spec.sheet ? <span className="prompt-hint">{t('skin.editor.picked', spec.sheet.width, spec.sheet.height)}</span> : null}
                </div>
                <FieldError id={errId(`${st}.sheet`)} text={sheetErr} />
                <div className="pet-skin-editor-numbers">
                  <label>
                    <span>{t('skin.editor.frames')}</span>
                    <input
                      id={fid(`${st}.frames`)}
                      type="number"
                      min={1}
                      max={FRAMES_MAX}
                      step={1}
                      aria-label={labelFor(t('skin.editor.frames'), st)}
                      aria-invalid={invalid(`${st}.frames`)}
                      aria-describedby={describedBy(`${st}.frames`)}
                      value={Number.isNaN(spec.frames) ? '' : spec.frames}
                      onChange={(e) => updateState(st, { frames: num(e.target.value) }, `${st}.frames`)}
                    />
                  </label>
                  <label>
                    <span>{t('skin.editor.fps')}</span>
                    <input
                      id={fid(`${st}.fps`)}
                      type="number"
                      min={1}
                      max={FPS_MAX}
                      step={1}
                      aria-label={labelFor(t('skin.editor.fps'), st)}
                      aria-invalid={invalid(`${st}.fps`)}
                      aria-describedby={describedBy(`${st}.fps`)}
                      value={Number.isNaN(spec.fps) ? '' : spec.fps}
                      onChange={(e) => updateState(st, { fps: num(e.target.value) }, `${st}.fps`)}
                    />
                  </label>
                </div>
                <FieldError id={errId(`${st}.frames`)} text={shown(`${st}.frames`)} />
                <FieldError id={errId(`${st}.fps`)} text={shown(`${st}.fps`)} />
                {reduced && spec.sheet ? (
                  <label className="pet-skin-editor-step">
                    <span>{t('skin.editor.frameStep')}</span>
                    <input
                      type="range"
                      min={0}
                      max={clamp(spec.frames, 1, FRAMES_MAX) - 1}
                      step={1}
                      aria-label={labelFor(t('skin.editor.frameStep'), st)}
                      value={Math.min(steps[st], clamp(spec.frames, 1, FRAMES_MAX) - 1)}
                      onChange={(e) => setSteps((p) => ({ ...p, [st]: Number(e.target.value) }))}
                    />
                  </label>
                ) : null}
              </fieldset>
            );
          })}
        </div>

        {replace ? (
          <div className="pet-skin-editor-replace">
            <p>{t('skin.replaceConfirm', replace.name)}</p>
            <button ref={replaceButton} type="button" className="btn" disabled={busy} onClick={() => void runReplace()}>
              {t('skin.replace')}
            </button>
          </div>
        ) : null}
        {status ? (
          <p role="alert" className="prompt-error">
            {status}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        <button type="button" disabled={busy} onClick={() => void act('export')}>
          {t('skin.editor.export')}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void act('install')}>
          {t('skin.import.install')}
        </button>
      </div>
    </DialogFrame>
  );
}
