import { useEffect, useState } from 'react';
import { probeWebSearch, readAssistantConfig, updateAssistantConfig, type AssistantConfig } from '../../assistant/config';
import { clearAllHistory, historyStats, type HistoryStats } from '../../assistant/history';
import { listSkins, removeSkinAndFallBack, skinChoices } from '../../assistant/skins/store';
import { DEFAULT_GALLERY_URL, browseGallery, submitToGallery } from '../../assistant/skins/gallery';
import { openSkinEditor } from '../../assistant/skins/SkinEditor';
import { exportSkinFile, importSkinFile } from '../../assistant/skins/transfer';
import type { SkinManifest } from '../../assistant/skins/types';
import type { WebSearchResult } from '../../assistant/web/ipc';
import { assistantSession } from '../../assistant/useAssistantSession';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { confirmDialog } from '../../labnote/host/dialogStore';
import { notify as toast } from '../../labnote/host/toastStore';
import { layoutStore, useLayout } from '../layoutStore';
import { openSettings } from '../SettingsModal';
import { Segmented } from '../Segmented';
import { SelectField } from '../SelectField';
import { SettingRow, Toggle } from './SettingRow';

/**
 * 설정 → 어시스턴트(assistant 명세 §10.1). 이 PC 의 ui.json(layoutStore 의 pet)에 산다. 줄은 그 기능이 동작하게 되는 작업에서
 * 하나씩 늘어난다: 보이기, 크기(정수 배율 2·3), 스킨(Task 16, 고르기와 삭제), 웹 검색 주소(Task 12, 이 PC 의 assistant.json),
 * 갤러리 주소(Task 19), 대화 기록(Task 10), 외부 도우미(Task 21, MCP 서버가 있는 연동 쪽으로 가는 단추). 줄 차례는 명세 §10.1 과 같다. 스킨 가져오기(Task 17), 내 스킨 만들기(Task 18), 갤러리(Task 19)는 묻는 창이 설정 창 뒤에 줄 서지 않게 `leave` 로 설정 창을 닫은 뒤에 연다.
 */
export function AssistantPage(
  props: { leave?: (after: () => Promise<void>) => void; showPage?: (page: 'integrations') => void } = {},
) {
  useLang();
  const { pet } = useLayout();
  return (
    <>
      <SettingRow
        label={t('settings.assistant.show')}
        description={t('settings.assistant.show.desc')}
        control={<Toggle label={t('settings.assistant.show')} checked={!pet.hidden} onChange={(on) => layoutStore.setPet({ hidden: !on })} />}
      />
      <SettingRow
        label={t('settings.assistant.size')}
        description={t('settings.assistant.size.desc')}
        control={
          <Segmented<'2' | '3'>
            label={t('settings.assistant.size')}
            value={pet.scale === 3 ? '3' : '2'}
            onChange={(v) => layoutStore.setPet({ scale: v === '3' ? 3 : 2 })}
            options={[
              { value: '2', label: t('settings.assistant.size.2') },
              { value: '3', label: t('settings.assistant.size.3') },
            ]}
          />
        }
      />
      <SkinRow leave={props.leave} />
      <WebSearchRow />
      <GalleryRow />
      <HistoryRow />
      <ExternalAssistantsRow showPage={props.showPage} />
    </>
  );
}

export interface SkinRowDeps {
  /** 지금 고른 스킨 id(기본: 이 PC 의 ui.json pet.skin). */
  active?: string;
  setSkin?: (id: string) => void;
  list?: () => Promise<SkinManifest[]>;
  /** 지우고, 쓰던 스킨이면 기본 스킨으로 돌린다. */
  remove?: (id: string) => Promise<void>;
  confirm?: (message: string) => Promise<boolean>;
  notify?: (kind: 'info' | 'warn', message: string) => void;
  /** 스킨 파일 가져오기(미리 보기와 확인을 거쳐 설치). */
  importSkin?: () => Promise<unknown>;
  /** 스킨 파일 내보내기(Rust 저장 창). */
  exportSkin?: (id: string) => Promise<boolean>;
  /** 내 스킨 만들기 창(Task 18). */
  makeSkin?: () => Promise<unknown>;
  /** 스킨 갤러리(Task 19): 미리 보기와 확인을 거쳐 설치. */
  gallery?: () => Promise<unknown>;
  /** 고른 스킨을 갤러리에 올리는 페이지를 연다(기본 스킨이면 안내만). */
  submit?: (id: string) => Promise<boolean>;
  /** 설정 창을 닫고 그 뒤에 `after` 를 한다(가져오기의 창들이 설정 창 뒤에 줄 서지 않게). 없으면 바로 한다. */
  leave?: (after: () => Promise<void>) => void;
}

/**
 * 스킨 줄(assistant 명세 §8.3, §10.1, plan Task 16): 기본 스킨(맨 앞)과 이 PC 에 설치한 스킨에서 고르고(ui.json pet.skin),
 * 고른 스킨을 지운다(확인 후, 되돌릴 수 없다). 기본 스킨은 지울 수 없다. 모르는 id 는 기본 스킨으로 보인다.
 * 이름·만든 사람·라이선스는 스킨 파일에서 온 글이라 글자로만 보인다(React 가 이스케이프한다).
 * "가져오기"는 설정 창을 닫고 파일을 골라 미리 보기·확인을 거쳐 설치한다(Task 17). "내보내기"는 고른 스킨(기본 스킨도)을 파일로 저장한다.
 */
export function SkinRow(deps: SkinRowDeps = {}) {
  useLang();
  const { pet } = useLayout();
  const active = deps.active ?? pet.skin;
  const setSkin = deps.setSkin ?? ((skin: string) => layoutStore.setPet({ skin }));
  const list = deps.list ?? (() => listSkins());
  const remove = deps.remove ?? ((id: string) => removeSkinAndFallBack(id));
  const confirm = deps.confirm ?? ((message: string) => confirmDialog(message, { confirmLabel: t('settings.assistant.skin.remove'), destructive: true }));
  const notify = deps.notify ?? toast;
  const importSkin = deps.importSkin ?? (() => importSkinFile());
  const exportSkin = deps.exportSkin ?? ((id: string) => exportSkinFile(id));
  const makeSkin = deps.makeSkin ?? (() => openSkinEditor());
  const gallery = deps.gallery ?? (() => browseGallery());
  const submit = deps.submit ?? ((id: string) => submitToGallery(id));
  const [installed, setInstalled] = useState<SkinManifest[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    list().then(
      (l) => setInstalled(l),
      () => setInstalled([])
    );
  useEffect(() => {
    let live = true;
    list().then(
      (l) => live && setInstalled(l),
      () => undefined
    );
    return () => {
      live = false;
    };
    // Read once when the pane opens.
  }, []);

  const choices = skinChoices(installed);
  const current = choices.find((c) => c.id === active) ?? choices[0];

  const run = async () => {
    if (current.builtin) return;
    if (!(await confirm(t('skin.removeConfirm', current.name)))) return;
    setBusy(true);
    try {
      await remove(current.id);
      notify('info', t('skin.removed'));
    } catch (err) {
      console.warn('[labnoteo] skin remove failed:', err);
      notify('warn', t('skin.removeFailed'));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  /** 설정 창을 닫고(창이 설정 창 뒤에 줄 서지 않게) `flow` 를 한다. 설정 창이 없으면 바로 하고 목록을 다시 읽는다. */
  const runOutside = (flow: () => Promise<unknown>) => {
    if (deps.leave) {
      deps.leave(async () => {
        await flow();
      });
      return;
    }
    setBusy(true);
    void flow().finally(() => {
      setBusy(false);
      void refresh();
    });
  };
  const runImport = () => runOutside(importSkin);

  const runExport = async () => {
    setBusy(true);
    try {
      await exportSkin(current.id);
    } finally {
      setBusy(false);
    }
  };

  const runSubmit = async () => {
    setBusy(true);
    try {
      await submit(current.id);
    } finally {
      setBusy(false);
    }
  };

  const label = t('settings.assistant.skin');
  return (
    <SettingRow
      label={label}
      description={`${t('settings.assistant.skin.desc')} ${t('settings.assistant.skin.info', current.author, current.licence)}`}
      control={
        <>
          <SelectField aria-label={label} value={current.id} onChange={(e) => setSkin(e.currentTarget.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.builtin ? t('settings.assistant.skin.builtin', c.name) : c.name}
              </option>
            ))}
          </SelectField>
          <button type="button" className="btn" disabled={busy} onClick={runImport}>
            {t('settings.assistant.skin.import')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void runExport()}>
            {t('settings.assistant.skin.export')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => runOutside(makeSkin)}>
            {t('settings.assistant.skin.make')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => runOutside(gallery)}>
            {t('settings.assistant.skin.gallery')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void runSubmit()}>
            {t('settings.assistant.skin.submit')}
          </button>
          <button type="button" className="btn danger" disabled={busy || current.builtin} onClick={() => void run()}>
            {t('settings.assistant.skin.remove')}
          </button>
        </>
      }
    />
  );
}

export interface WebSearchRowDeps {
  read?: () => Promise<AssistantConfig>;
  /** 웹 검색 주소만 바꾼다(빈 글은 지우기). Rust 가 정리해 저장한 설정을 돌려준다. */
  save?: (url: string) => Promise<AssistantConfig>;
  /** 저장하지 않은 주소로 시험 검색. */
  probe?: (url: string) => Promise<WebSearchResult>;
}

/** 시험 검색이나 저장의 거절을 짧은 안내로. `message` 는 Rust 글이라 보이지 않는다. */
function searchErrorText(e: unknown): string {
  const kind = (e as { kind?: unknown } | null)?.kind;
  switch (kind) {
    case 'badUrl':
    case 'invalidUrl':
      return t('settings.assistant.search.badUrl');
    case 'insecure':
      return t('settings.assistant.search.insecure');
    case 'jsonDisabled':
      return t('settings.assistant.search.jsonDisabled');
    case 'rateLimited':
      return t('settings.assistant.search.rateLimited');
    case 'enginesDown':
      return t('settings.assistant.search.enginesDown');
    default:
      return t('settings.assistant.search.failed');
  }
}

/** 주소에 아이디나 비밀번호(`user:pass@`)가 있는지. 그런 주소는 Rust 로 보내지도 않는다(저장·시험 검색 모두). 못 읽는 주소는 Rust 가 거절한다. */
export function hasCredentials(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.username !== '' || u.password !== '';
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw.trim());
  }
}

/**
 * 웹 검색 주소 줄(assistant 명세 §7.1, plan Task 12): 이 PC 의 `assistant.json` 에 SearXNG 주소를 둔다. 보관함에는 두지 않는다.
 * Enter 나 칸을 떠나면 저장하고(Rust 가 검사), "확인"은 칸에 적힌 주소(저장 전)로 시험 검색을 한 번 한다.
 * 결과와 거절은 `role=status` 한 줄로 알린다. 한글 입력 중의 Enter 는 저장하지 않는다.
 */
export function WebSearchRow(deps: WebSearchRowDeps = {}) {
  useLang();
  const read = deps.read ?? (() => readAssistantConfig());
  const save = deps.save ?? ((url: string) => updateAssistantConfig({ searxngUrl: url || undefined }));
  const probe = deps.probe ?? ((url: string) => probeWebSearch(url));
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  /** 아이디·비밀번호가 든 주소면 그 자리에서 거절한다(저장하지도, 시험하지도 않는다). */
  const refuseCredentials = (url: string): boolean => {
    if (!hasCredentials(url)) return false;
    setInvalid(true);
    setStatus(t('settings.assistant.search.credentials'));
    return true;
  };

  useEffect(() => {
    let live = true;
    read().then(
      (cfg) => {
        if (!live) return;
        setValue(cfg.searxngUrl ?? '');
        setSaved(cfg.searxngUrl ?? '');
      },
      () => undefined
    );
    return () => {
      live = false;
    };
    // Read once when the pane opens.
  }, []);

  const commit = async () => {
    const next = value.trim();
    if (next === saved) return;
    if (refuseCredentials(next)) return;
    setInvalid(false);
    try {
      const stored = await save(next);
      const url = stored.searxngUrl ?? '';
      setSaved(url);
      setValue(url);
      setStatus(t(url ? 'settings.assistant.search.saved' : 'settings.assistant.search.cleared'));
    } catch (e) {
      const kind = (e as { kind?: unknown } | null)?.kind;
      setStatus(kind === 'badUrl' ? searchErrorText(e) : t('settings.assistant.search.saveFailed'));
    }
  };

  const check = async () => {
    const url = value.trim();
    if (!url) return;
    if (refuseCredentials(url)) return;
    setBusy(true);
    try {
      const r = await probe(url);
      setStatus(t('settings.assistant.search.ok', r.hits.length));
    } catch (e) {
      setStatus(searchErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const label = t('settings.assistant.search');
  return (
    <SettingRow
      label={label}
      description={t('settings.assistant.search.desc')}
      control={
        <>
          <input
            type="text"
            className="setting-text"
            aria-label={label}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            maxLength={2048}
            placeholder={t('settings.assistant.search.placeholder')}
            aria-invalid={invalid || undefined}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (invalid) setInvalid(false);
            }}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void commit();
            }}
          />
          <button type="button" className="btn" disabled={busy || value.trim() === ''} onClick={() => void check()}>
            {t('settings.assistant.search.check')}
          </button>
          <span role="status" className="setting-status">
            {status}
          </span>
        </>
      }
    />
  );
}

export interface GalleryRowDeps {
  read?: () => Promise<AssistantConfig>;
  /** 갤러리 주소만 바꾼다(빈 글은 기본 주소로). Rust 가 정리해 저장한 설정을 돌려준다. */
  save?: (url: string) => Promise<AssistantConfig>;
}

/**
 * 갤러리 주소 줄(assistant 명세 §8.5, §10.1, plan Task 19): 이 PC 의 `assistant.json` 에 스킨 갤러리 목록(index.json) 주소를 둔다.
 * 비우면 기본 갤러리(자리 글로 보인다). Enter 나 칸을 떠나면 저장하고(Rust 가 https 만 받는다), "기본 주소로"는 지운다.
 * 결과는 `role=status` 한 줄로 알린다. 한글 입력 중의 Enter 는 저장하지 않는다.
 */
export function GalleryRow(deps: GalleryRowDeps = {}) {
  useLang();
  const read = deps.read ?? (() => readAssistantConfig());
  const save = deps.save ?? ((url: string) => updateAssistantConfig({ galleryUrl: url || undefined }));
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let live = true;
    read().then(
      (cfg) => {
        if (!live) return;
        setValue(cfg.galleryUrl ?? '');
        setSaved(cfg.galleryUrl ?? '');
      },
      () => undefined
    );
    return () => {
      live = false;
    };
    // Read once when the pane opens.
  }, []);

  const store = async (next: string) => {
    try {
      const stored = await save(next);
      const url = stored.galleryUrl ?? '';
      setSaved(url);
      setValue(url);
      setStatus(t(url ? 'settings.assistant.gallery.saved' : 'settings.assistant.gallery.cleared'));
    } catch (e) {
      const kind = (e as { kind?: unknown } | null)?.kind;
      setStatus(kind === 'badUrl' ? t('settings.assistant.gallery.badUrl') : t('settings.assistant.gallery.saveFailed'));
    }
  };

  const commit = async () => {
    const next = value.trim();
    if (next === saved) return;
    await store(next);
  };

  const label = t('settings.assistant.gallery');
  return (
    <SettingRow
      label={label}
      description={t('settings.assistant.gallery.desc')}
      control={
        <>
          <input
            type="text"
            className="setting-text"
            aria-label={label}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            maxLength={2048}
            placeholder={DEFAULT_GALLERY_URL}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void commit();
            }}
          />
          <button type="button" className="btn" disabled={saved === '' && value.trim() === ''} onClick={() => void store('')}>
            {t('settings.assistant.gallery.reset')}
          </button>
          <span role="status" className="setting-status">
            {status}
          </span>
        </>
      }
    />
  );
}

export interface HistoryRowDeps {
  stats?: () => Promise<HistoryStats>;
  clearAll?: () => Promise<number>;
  confirm?: (message: string) => Promise<boolean>;
  /** 모두 지운 뒤: 열린 대화를 비운다. */
  onCleared?: () => void;
  notify?: (kind: 'info' | 'warn', message: string) => void;
}

/**
 * 대화 기록 줄(assistant 명세 §6.1, §10.1): 기록이 있는 실험 수와 "모든 기록 지우기"(확인 후, 되돌릴 수 없다).
 * 기록은 이 PC 의 앱 데이터 폴더에만 있다(보관함에는 쓰지 않는다). 수를 읽지 못하면 수는 보이지 않고 단추는 그대로다.
 */
export function HistoryRow(deps: HistoryRowDeps = {}) {
  useLang();
  const stats = deps.stats ?? (() => historyStats());
  const clearAll = deps.clearAll ?? (() => clearAllHistory());
  const confirm =
    deps.confirm ?? ((message: string) => confirmDialog(message, { confirmLabel: t('history.clearAction'), destructive: true }));
  const onCleared = deps.onCleared ?? (() => assistantSession.forget());
  const notify = deps.notify ?? toast;
  const [folders, setFolders] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    stats().then(
      (s) => setFolders(s.folders),
      () => setFolders(undefined)
    );
  useEffect(() => {
    let live = true;
    stats().then(
      (s) => live && setFolders(s.folders),
      () => undefined
    );
    return () => {
      live = false;
    };
    // Read once when the pane opens.
  }, []);

  const run = async () => {
    if (!(await confirm(t('history.clearAllConfirm')))) return;
    setBusy(true);
    try {
      await clearAll();
      onCleared();
      notify('info', t('history.clearedAll'));
    } catch (err) {
      console.warn('[labnoteo] assistant history clear-all failed:', err);
      notify('warn', t('history.clearFailed'));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const desc = t('settings.assistant.history.desc');
  return (
    <SettingRow
      label={t('settings.assistant.history')}
      description={folders === undefined ? desc : `${t('settings.assistant.history.count', folders)} ${desc}`}
      control={
        <button type="button" className="btn danger" disabled={busy || folders === 0} onClick={() => void run()}>
          {t('settings.assistant.history.clearAll')}
        </button>
      }
    />
  );
}

export interface ExternalAssistantsRowDeps {
  /** 설정 창 안에서 다른 쪽으로 옮긴다(초점은 그 탭으로). 없으면(설정 창 밖) 설정 창을 그 쪽으로 연다. */
  showPage?: (page: 'integrations') => void;
}

/**
 * 외부 도우미 줄(assistant 명세 §5, §10.1, plan Task 21): Claude Code·DeepSeek Harness 같은 외부 도구는 앱 안에 넣지 않고
 * labnoteO MCP 서버(와 스킬)로 연결한다. 단추는 MCP 서버 스위치와 토큰이 있는 연동 쪽을 연다.
 */
export function ExternalAssistantsRow(deps: ExternalAssistantsRowDeps = {}) {
  useLang();
  // SettingsModal 과 서로 가져오지만 openSettings 는 누를 때만 부른다(모듈을 읽는 동안에는 부르지 않는다).
  const show = deps.showPage ?? ((page: 'integrations') => void openSettings(page));
  return (
    <SettingRow
      label={t('settings.assistant.external')}
      description={t('settings.assistant.external.desc')}
      control={
        <button type="button" className="btn" onClick={() => show('integrations')}>
          {t('settings.assistant.external.open')}
        </button>
      }
    />
  );
}
