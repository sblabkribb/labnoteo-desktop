import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { t } from '../i18n/t';
import { editorTheme } from './theme';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { VAULT_CHANGED, type ListenFn } from '../vault/useVaultEvents';
import { lineSeparatorOf, loadDocument, parseRaw, saveDocument, toRaw, type LoadedDocument } from './documentIo';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 마지막 입력 뒤 이만큼 조용하면 저장한다. */
export const AUTOSAVE_MS = 2000;
/** 계속 치고 있어도 이 시간이 지나면 저장한다: 무입력 대기만으로는 쉬지 않고 쓰는 사람의 글이 저장되지 않는다. */
export const MAX_AUTOSAVE_MS = 10_000;
/** 저장이 연달아 이만큼 실패하면 더 다시 시도하지 않는다(경고는 계속 보인다). 다음 입력이 한 번 더 시도한다. */
export const MAX_SAVE_ATTEMPTS = 5;

export interface EditorHandle {
  /** 다른 노트로 넘어가기 전에 부른다. 잃을 편집이 없으면(저장됐거나 원래 깨끗하면) true. */
  flush(): Promise<boolean>;
}

interface Props {
  /** vault-relative POSIX 경로. 노트가 바뀌면 호출자가 `key` 를 바꿔 새로 마운트한다 — 상태가 섞이지 않게. */
  path: string;
  invoke?: InvokeFn;
  listen?: ListenFn;
  autosaveMs?: number;
  maxAutosaveMs?: number;
  /** 창 닫기 요청을 가로채 저장하기 위한 이음새. 기본은 Tauri 창. */
  windowApi?: WindowApi;
}

export interface WindowApi {
  onCloseRequested(handler: (e: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
}

/**
 * 열린 노트와 디스크의 관계.
 * - changed: 편집하는 동안 밖에서 바뀌었다 (`current` 는 사용자가 본 디스크 내용).
 * - gone: 밖에서 지워지거나 이름이 바뀌었다.
 * 둘 중 하나인 동안에는 아무것도 저절로 쓰이지 않는다: 자동 저장도, Ctrl+S 도 대화상자만 다시 연다.
 */
type External = { kind: 'changed'; current: string } | { kind: 'gone' };

const LOCKED = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  {
    path,
    invoke = tauriInvoke as InvokeFn,
    listen = tauriListen as ListenFn,
    autosaveMs = AUTOSAVE_MS,
    maxAutosaveMs = MAX_AUTOSAVE_MS,
    windowApi,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const lock = useRef(new Compartment());
  const docRef = useRef<LoadedDocument>();
  /** 마지막으로 저장했거나 읽은 에디터 본문. 이것과 같으면 깨끗하다 (되돌리기로 돌아와도). */
  const baseline = useRef('');
  const externalRef = useRef<External | null>(null);
  const saveFailures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const maxTimer = useRef<ReturnType<typeof setTimeout>>();
  const clearTimers = () => {
    clearTimeout(timer.current);
    clearTimeout(maxTimer.current);
    maxTimer.current = undefined;
  };
  const extensions = useRef<(doc: LoadedDocument | undefined) => Extension[]>(() => []);
  const locked = useRef(true);
  /** 저장과 디스크 확인을 한 줄로 세운다: 확인이 저장 도중의 반쯤 쓰인 상태를 보지 않게. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const checkQueued = useRef(false);
  const latest = useRef({ invoke, autosaveMs, maxAutosaveMs });
  latest.current = { invoke, autosaveMs, maxAutosaveMs };

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);
  const [external, setExternalState] = useState<External | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [closeAsk, setCloseAsk] = useState(false);
  const win = useRef<WindowApi>();

  // 아래 함수들은 ref 와 setState 만 만지므로 렌더마다 새로 만들어도 같은 일을 한다. effect 는 api.current 를 거쳐 부른다.
  const api = useRef({} as ReturnType<typeof makeApi>);
  function makeApi() {
    // sliceDoc 은 상태의 줄 구분자로 잇는다. doc.toString() 은 항상 LF 로 이어서, 섞인 파일의 CRLF 줄이 LF 가 된다.
    const text = () => viewRef.current?.state.sliceDoc() ?? '';
    const isDirty = () => text() !== baseline.current;
    const setExternal = (e: External | null) => {
      externalRef.current = e;
      setExternalState(e);
    };
    const adopt = (doc: LoadedDocument) => {
      const view = viewRef.current;
      if (view) {
        // 새 상태를 통째로 올린다: 되돌리기 기록이 비어서 시작하므로, 불러오기 이전의 본문(빈 본문 포함)으로
        // 되돌릴 수 없다. 되돌리기가 그 본문을 디스크에 저장해 버리는 일이 없다.
        // 조용한 다시 읽기는 보이지 않아야 한다: 커서와 스크롤 위치를 새 본문 안에서 그대로 둔다.
        // 길이는 만들어진 상태의 doc.length 로 잰다 — 섞인 CRLF 노트는 doc.text.length 보다 짧다(CRLF 가 한 칸).
        const { anchor, head } = view.state.selection.main;
        const top = view.scrollDOM.scrollTop;
        const extensionsFor = extensions.current(doc);
        const len = EditorState.create({ doc: doc.text, extensions: extensionsFor }).doc.length;
        const next = EditorState.create({
          doc: doc.text,
          selection: { anchor: Math.min(anchor, len), head: Math.min(head, len) },
          extensions: extensionsFor,
        });
        view.setState(next); // 여기서 던져도 아래의 기준 본문은 아직 바뀌지 않았다
        view.scrollDOM.scrollTop = top;
        requestAnimationFrame(() => (view.scrollDOM.scrollTop = top));
      }
      // 뷰가 새 본문을 보여 준 뒤에만 기준을 옮긴다: 뷰와 기준이 어긋나면 낡은 버퍼가 저장될 수 있다.
      docRef.current = doc;
      baseline.current = doc.text;
      saveFailures.current = 0; // 다시 읽기는 새 출발이다
      setCloseAsk(false);
      setExternal(null);
      setDialogOpen(false);
      setSaveError(false);
      setDirty(false);
    };
    const run = <T,>(fn: () => Promise<T>): Promise<T> => {
      const p = chain.current.then(fn);
      chain.current = p.catch(() => undefined);
      return p;
    };
    const scheduleAutosave = () => {
      clearTimeout(timer.current);
      if (externalRef.current) return; // 대화상자가 답을 받기 전에는 자동 저장도 멈춘다
      const fire = () => void run(() => doSave());
      timer.current = setTimeout(fire, latest.current.autosaveMs);
      maxTimer.current ??= setTimeout(fire, latest.current.maxAutosaveMs);
    };

    /** 저장. 저장된(또는 저장할 것이 없는) 상태면 true. `force` 는 대화상자에서 덮어쓰기를 고른 경우다. */
    async function doSave(force?: { against?: string }): Promise<boolean> {
      clearTimers();
      const doc = docRef.current;
      if (!doc || !viewRef.current) return false;
      if (!force && externalRef.current) {
        setDialogOpen(true);
        return false;
      }
      const body = text();
      if (!force && body === baseline.current) return true;
      let result;
      try {
        result = await saveDocument(doc, body, { force: !!force, against: force?.against, invoke: latest.current.invoke });
      } catch {
        setSaveError(true);
        // 일시적인 실패(백신 잠금, 디스크 가득)면 키를 다시 칠 때까지 기다리지 않고 다시 시도한다 —
        // 간격을 두 배씩 늘리고, MAX_SAVE_ATTEMPTS 번 연달아 실패하면 멈춘다(경고는 남는다).
        saveFailures.current += 1;
        if (saveFailures.current < MAX_SAVE_ATTEMPTS && !externalRef.current) {
          const delay = latest.current.autosaveMs * 2 ** (saveFailures.current - 1);
          timer.current = setTimeout(() => void run(() => doSave()), delay);
        }
        return false;
      }
      if (!result.ok) {
        setExternal({ kind: 'changed', current: result.current });
        setDialogOpen(true);
        return false;
      }
      saveFailures.current = 0;
      docRef.current = { ...doc, text: body, loadedText: toRaw(doc, body) };
      baseline.current = body;
      setExternal(null);
      setDialogOpen(false);
      setSaveError(false);
      if (!isDirty()) setCloseAsk(false);
      // 저장하는 사이 더 쳤을 수 있다.
      const still = isDirty();
      setDirty(still);
      if (still) scheduleAutosave();
      return true;
    }

    /** 파일이 밖에서 바뀌었는지 디스크를 다시 읽어 본다. 이벤트의 종류는 믿지 않는다: 읽은 결과가 진실이다. */
    async function check() {
      const doc = docRef.current;
      if (!doc) return;
      let raw: string;
      try {
        raw = await latest.current.invoke<string>('vault_read', { path: doc.path });
      } catch (e) {
        if (hasErrorKind(e, ERROR_KINDS.notFound)) {
          clearTimers();
          setExternal({ kind: 'gone' });
          setDialogOpen(true);
        }
        return; // 그 밖의 읽기 실패로는 아무것도 단정하지 않는다. 저장 때의 기대값 비교가 마지막 방어선이다.
      }
      if (raw === doc.loadedText) {
        // 내 저장의 메아리이거나, 사라졌다가 같은 내용으로 돌아왔다.
        if (externalRef.current) {
          setExternal(null);
          setDialogOpen(false);
          if (isDirty()) scheduleAutosave();
        }
        return;
      }
      if (!isDirty()) {
        adopt(parseRaw(doc.path, raw)); // 잃을 편집이 없다: 조용히 새 내용을 보여 준다
        return;
      }
      clearTimers();
      const wasOpen = externalRef.current !== null;
      setExternal({ kind: 'changed', current: raw });
      if (!wasOpen) setDialogOpen(true);
    }

    return {
      isDirty,
      scheduleAutosave,
      save: (force?: { against?: string }) => run(() => doSave(force)),
      queueCheck: () => {
        if (checkQueued.current) return;
        checkQueued.current = true;
        void run(async () => {
          checkQueued.current = false;
          await check();
        });
      },
      flush: () => run(async () => (isDirty() ? doSave() : true)),
      adopt,
      reload: () =>
        run(async () => {
          try {
            adopt(await loadDocument(path, latest.current.invoke));
          } catch (e) {
            if (hasErrorKind(e, ERROR_KINDS.notFound)) setExternal({ kind: 'gone' });
            else setSaveError(true);
          }
        }),
    };
  }
  api.current = makeApi();

  useImperativeHandle(ref, () => ({ flush: () => api.current.flush() }), []);

  // 열기: 읽어서 에디터에 채운다.
  useEffect(() => {
    let live = true;
    // 그림자 루트 안에 만든다: CodeMirror 의 스타일이 <style> 태그 대신 adoptedStyleSheets 로 들어가, CSP 에 'unsafe-inline' 을 열지 않아도 된다.
    // (개발 모드의 StrictMode 는 effect 를 두 번 돌린다: 이미 붙인 루트는 다시 붙일 수 없으니 재사용한다.)
    const shadow = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    // 상태(확장 포함)는 노트를 채울 때마다 새로 만든다: 되돌리기 기록이 읽기 이전으로 거슬러 가지 못하게.
    extensions.current = (doc) => [
      // 줄 구분자는 파일에서 온 그대로: 섞인 파일에서도 손대지 않은 줄의 바이트가 바뀌지 않는다.
      EditorState.lineSeparator.of(doc ? lineSeparatorOf(doc) : '\n'),
      history(),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void api.current.save();
              return true;
            },
          },
        ]),
      ),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      editorTheme,
      // 섞인 줄바꿈 파일의 소수 쪽 줄 끝(CR 또는 LF)이 눈에 보이는 기호로 나온다 — 줄바꿈처럼 보이는데 줄이 아닌 것이 되지 않게.
      highlightSpecialChars(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': t('editor.label') }),
      lock.current.of(locked.current ? LOCKED : []),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const dirty = api.current.isDirty();
        setDirty(dirty);
        if (!dirty) setCloseAsk(false); // 되돌려서 깨끗해졌다: 저장 안 된 편집 때문에 던진 질문은 거둔다
        api.current.scheduleAutosave();
      }),
    ];
    const view = new EditorView({
      parent: shadow,
      root: shadow,
      state: EditorState.create({ doc: '', extensions: extensions.current(undefined) }),
    });
    viewRef.current = view;
    loadDocument(path, invoke).then(
      (doc) => {
        if (!live) return;
        api.current.adopt(doc);
        setStatus('ready');
      },
      () => live && setStatus('error'),
    );
    return () => {
      live = false;
      clearTimers();
      // 노트를 닫는데 저장 안 된 편집이 있으면 마지막으로 한 번 저장해 본다(충돌이면 쓰지 않는다).
      if (!externalRef.current && api.current.isDirty()) void api.current.save();
      view.destroy();
    };
    // 노트마다 새로 마운트한다(key): path 가 바뀌는 경우는 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 대화상자가 열려 있는 동안, 그리고 읽기가 끝나기 전에는 편집을 막는다: 사용자가 결정하는 내용이 바뀌지 않게.
  useEffect(() => {
    locked.current = status !== 'ready' || dialogOpen;
    viewRef.current?.dispatch({ effects: lock.current.reconfigure(locked.current ? LOCKED : []) });
  }, [status, dialogOpen]);

  // 밖에서 바뀜: 이 노트나 이 노트를 담은 폴더가 바뀌었거나, 무엇이 바뀌었는지 놓쳤다(빈 경로).
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    listen(VAULT_CHANGED, (e) => {
      const p = e.payload.path;
      if (live && (p === '' || p === path || path.startsWith(`${p}/`))) api.current.queueCheck();
    }).then(
      (fn) => (live ? (unlisten = fn) : fn()),
      () => undefined,
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, [path, listen]);

  // 창을 닫을 때: 저장 안 된 편집이 있으면 저장한 뒤에 닫는다. 이 가드는 항상 켜져 있다 — 닫기 요청마다 다시 검사한다.
  // 저장하지 못하면(충돌 등) 닫지 않고, 저장하지 않고 닫을지 명시적으로 묻는다. 그 편집이 유일한 사본일 수 있다.
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    try {
      win.current = windowApi ?? (getCurrentWindow() as unknown as WindowApi);
    } catch {
      return; // 창 API 가 없는 환경(테스트 등)
    }
    const w = win.current;
    w.onCloseRequested(async (ev) => {
      if (!api.current.isDirty()) return; // 잃을 것이 없다: 기본 동작대로 닫힌다
      ev.preventDefault();
      // flush() 는 지금은 자기 실패를 직접 잡는다. 그래도 거부되면 이 핸들러가 죽어 창이 닫히지도 묻지도 않는다 —
      // 닫기 버튼이 아무 말 없이 먹통이 된다. 던진 저장은 저장되지 않은 것이므로 묻는다.
      let saved = false;
      try {
        saved = await api.current.flush();
      } catch {
        saved = false;
      }
      if (saved) await w.destroy();
      else setCloseAsk(true);
    }).then(
      (fn) => (live ? (unlisten = fn) : fn()),
      () => undefined,
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, [windowApi]);

  const gone = external?.kind === 'gone';
  return (
    <section aria-label={t('editor.label')}>
      <p>
        {path} {(external || dirty) && <span role="status">{external ? t('editor.conflicted') : t('editor.dirty')}</span>}
      </p>
      {status === 'loading' && <p>{t('editor.loading')}</p>}
      {status === 'error' && <p role="alert">{t('editor.loadError')}</p>}
      {saveError && <p role="alert">{t('editor.saveError')}</p>}
      {closeAsk && (
        <p role="alert">
          {t('editor.closeAsk.body')}{' '}
          <button type="button" onClick={() => void win.current?.destroy()}>
            {t('editor.closeAsk.discard')}
          </button>{' '}
          <button type="button" onClick={() => setCloseAsk(false)}>
            {t('editor.closeAsk.stay')}
          </button>
        </p>
      )}
      <div ref={host} hidden={status !== 'ready'} />
      {dialogOpen && external && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="editor-ext-title"
          aria-describedby="editor-ext-body"
          onKeyDown={(e) => e.key === 'Escape' && setDialogOpen(false)}
        >
          <h2 id="editor-ext-title">{t(gone ? 'editor.gone.title' : 'editor.changed.title')}</h2>
          <p id="editor-ext-body">{t(gone ? 'editor.gone.body' : 'editor.changed.body')}</p>
          {!gone && (
            <button type="button" onClick={() => void api.current.reload()}>
              {t('editor.changed.reload')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void api.current.save({ against: external.kind === 'changed' ? external.current : '' })}
          >
            {t(gone ? 'editor.gone.recreate' : 'editor.changed.overwrite')}
          </button>
          <button type="button" className="primary" autoFocus onClick={() => setDialogOpen(false)}>
            {t('editor.keep')}
          </button>
        </div>
      )}
    </section>
  );
});
