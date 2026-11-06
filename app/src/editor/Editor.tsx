import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { t } from '../i18n/t';
import { VAULT_CHANGED, type ListenFn } from '../vault/useVaultEvents';
import { loadDocument, parseRaw, saveDocument, toRaw, type LoadedDocument } from './documentIo';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 마지막 입력 뒤 이만큼 조용하면 저장한다. */
export const AUTOSAVE_MS = 2000;

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
  { path, invoke = tauriInvoke as InvokeFn, listen = tauriListen as ListenFn, autosaveMs = AUTOSAVE_MS },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const lock = useRef(new Compartment());
  const docRef = useRef<LoadedDocument>();
  /** 마지막으로 저장했거나 읽은 에디터 본문. 이것과 같으면 깨끗하다 (되돌리기로 돌아와도). */
  const baseline = useRef('');
  const externalRef = useRef<External | null>(null);
  const programmatic = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /** 저장과 디스크 확인을 한 줄로 세운다: 확인이 저장 도중의 반쯤 쓰인 상태를 보지 않게. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const checkQueued = useRef(false);
  const latest = useRef({ invoke, autosaveMs });
  latest.current = { invoke, autosaveMs };

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);
  const [external, setExternalState] = useState<External | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // 아래 함수들은 ref 와 setState 만 만지므로 렌더마다 새로 만들어도 같은 일을 한다. effect 는 api.current 를 거쳐 부른다.
  const api = useRef({} as ReturnType<typeof makeApi>);
  function makeApi() {
    const text = () => viewRef.current?.state.doc.toString() ?? '';
    const isDirty = () => text() !== baseline.current;
    const setExternal = (e: External | null) => {
      externalRef.current = e;
      setExternalState(e);
    };
    const setBuffer = (next: string) => {
      const view = viewRef.current;
      if (!view) return;
      programmatic.current = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      programmatic.current = false;
    };
    const adopt = (doc: LoadedDocument) => {
      docRef.current = doc;
      baseline.current = doc.text;
      setBuffer(doc.text);
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
      timer.current = setTimeout(() => void run(() => doSave()), latest.current.autosaveMs);
    };

    /** 저장. 저장된(또는 저장할 것이 없는) 상태면 true. `force` 는 대화상자에서 덮어쓰기를 고른 경우다. */
    async function doSave(force?: { against?: string }): Promise<boolean> {
      clearTimeout(timer.current);
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
        return false;
      }
      if (!result.ok) {
        setExternal({ kind: 'changed', current: result.current });
        setDialogOpen(true);
        return false;
      }
      docRef.current = { ...doc, text: body, loadedText: toRaw(doc, body) };
      baseline.current = body;
      setExternal(null);
      setDialogOpen(false);
      setSaveError(false);
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
        if ((e as { kind?: string } | null)?.kind === 'notFound') {
          clearTimeout(timer.current);
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
      clearTimeout(timer.current);
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
            if ((e as { kind?: string } | null)?.kind === 'notFound') setExternal({ kind: 'gone' });
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
    const view = new EditorView({
      parent: shadow,
      root: shadow,
      state: EditorState.create({
        doc: '',
        extensions: [
          // CR 단독도 줄바꿈으로 세지 않는다: 본문에 있던 그대로 남긴다.
          EditorState.lineSeparator.of('\n'),
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
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          EditorView.theme({ '&': { minHeight: '50vh' } }),
          EditorView.contentAttributes.of({ 'aria-label': t('editor.label') }),
          lock.current.of(LOCKED),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || programmatic.current) return;
            setDirty(api.current.isDirty());
            api.current.scheduleAutosave();
          }),
        ],
      }),
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
      clearTimeout(timer.current);
      // 노트를 닫는데 저장 안 된 편집이 있으면 마지막으로 한 번 저장해 본다(충돌이면 쓰지 않는다).
      if (!externalRef.current && api.current.isDirty()) void api.current.save();
      view.destroy();
    };
    // 노트마다 새로 마운트한다(key): path 가 바뀌는 경우는 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 대화상자가 열려 있는 동안, 그리고 읽기가 끝나기 전에는 편집을 막는다: 사용자가 결정하는 내용이 바뀌지 않게.
  useEffect(() => {
    const locked = status !== 'ready' || dialogOpen;
    viewRef.current?.dispatch({ effects: lock.current.reconfigure(locked ? LOCKED : []) });
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

  const gone = external?.kind === 'gone';
  return (
    <section aria-label={t('editor.label')}>
      <p>
        {path} {(external || dirty) && <span role="status">{external ? t('editor.conflicted') : t('editor.dirty')}</span>}
      </p>
      {status === 'loading' && <p>{t('editor.loading')}</p>}
      {status === 'error' && <p role="alert">{t('editor.loadError')}</p>}
      {saveError && <p role="alert">{t('editor.saveError')}</p>}
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
          <button type="button" autoFocus onClick={() => setDialogOpen(false)}>
            {t('editor.keep')}
          </button>
        </div>
      )}
    </section>
  );
});
