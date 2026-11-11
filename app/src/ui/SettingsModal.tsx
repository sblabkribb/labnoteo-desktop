import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { DialogFrame } from '../labnote/host/DialogFrame';
import { currentDialog, openDialog, type DialogSpec } from '../labnote/host/dialogStore';
import type { AppSettings } from '../labnote/settings';
import { IntegrationSettingsPage, type IntegrationDeps } from '../integrations/IntegrationSettingsDialog';
import type { Theme } from '../theme/useTheme';
import { Icon, type IconName } from './Icon';
import { AboutPage } from './settings/AboutPage';
import { AssistantPage } from './settings/AssistantPage';
import { EditorPage } from './settings/EditorPage';
import { ExperimentsPage } from './settings/ExperimentsPage';
import { GeneralPage } from './settings/GeneralPage';
import { SamplesPage, type SamplesDeps } from './settings/SamplesPage';
import { ShortcutsPage } from './settings/ShortcutsPage';
import { rovingStop } from './roving';

/** 설정 창의 쪽들. 왼쪽 목록의 순서다. */
export const SETTINGS_PAGES = ['general', 'editor', 'experiments', 'samples', 'integrations', 'assistant', 'shortcuts', 'about'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** 설정 창이 쓰는 바깥 값과 함수. App 이 열 때마다 지금 값으로 만든다(setSettingsSource). */
export interface SettingsDeps {
  /** 지금 테마(이 PC 의 저장소). */
  theme(): Theme;
  setTheme(theme: Theme): void;
  /** 지금 보관함 설정. */
  settings(): AppSettings;
  /** 보관함 설정을 바꾸고 저장한다(useVaultSettings.update). */
  update(patch: Partial<AppSettings>): Promise<void>;
  /** 앱 버전(정보 쪽). 아직 모르면 ''. */
  version: string;
  integrations: IntegrationDeps;
  samples: SamplesDeps;
}

/** 설정 창이 닫힌 뒤에 할 일(묻는 대화상자가 설정 창 뒤에 줄 서지 않게, 닫은 다음에 연다). */
export type SettingsAfter = () => Promise<void>;

let source: (() => SettingsDeps | undefined) | undefined;

/** 설정 창의 값을 대는 함수를 건다(App: 보관함이 열려 있고 설정을 읽은 동안). 떼는 함수를 돌려준다. */
export function setSettingsSource(fn: () => SettingsDeps | undefined): () => void {
  source = fn;
  return () => {
    if (source === fn) source = undefined;
  };
}

/**
 * 설정 창을 `page` 쪽으로 연다(Ctrl+,, 보관함 줄의 톱니, 모양 창의 "모든 설정 열기", 팔레트, 연동·샘플 설정 명령).
 * 보관함 설정을 아직 읽지 못했으면(값이 없으면) 아무것도 하지 않는다. 이미 보이고 있으면 하나 더 열지 않는다.
 * 닫힌 뒤 할 일이 있으면(샘플 폴더 옮기기 등) 그것까지 기다린다.
 * `opts.focus`: 'githubToken' 이면 연동 쪽의 GitHub 고급 칸을 펴고 토큰 칸에 초점을 준다(로그인 대화상자의 "토큰으로 연결").
 */
export async function openSettings(page: SettingsPage = 'general', opts?: { focus?: 'githubToken' }): Promise<void> {
  const deps = source?.();
  if (!deps) return;
  if (currentDialog()?.spec.kind === 'settings') return;
  const spec: DialogSpec = opts?.focus ? { kind: 'settings', page, deps, focus: opts.focus } : { kind: 'settings', page, deps };
  const after = await openDialog<SettingsAfter | undefined>(spec, undefined);
  if (after) await after();
}

const PAGE_ICON: Record<SettingsPage, IconName> = {
  general: 'settings',
  editor: 'file-text',
  experiments: 'flask-conical',
  samples: 'test-tube',
  integrations: 'link',
  assistant: 'bot',
  shortcuts: 'keyboard',
  about: 'info',
};

/** 번역 키는 글자 그대로 둔다(카탈로그 검사가 키를 찾는다). */
const PAGE_LABEL: Record<SettingsPage, () => string> = {
  general: () => t('settings.page.general'),
  editor: () => t('settings.page.editor'),
  experiments: () => t('settings.page.experiments'),
  samples: () => t('settings.page.samples'),
  integrations: () => t('settings.page.integrations'),
  assistant: () => t('settings.page.assistant'),
  shortcuts: () => t('settings.page.shortcuts'),
  about: () => t('settings.page.about'),
};

/**
 * Obsidian 식 설정 창(spec §3.6): 왼쪽에 쪽 목록(세로 tablist: ↑/↓·Home/End 가 쪽을 바꾸고 초점을 옮긴다), 오른쪽에 그 쪽의 줄들.
 * 한 번 연 쪽은 숨겨 둔 채 남긴다: 쪽을 오가도 쓰던 칸이 남는다. 닫을 때(Esc, ×) 연동 쪽의 아직 떠나지 않은 칸을 저장한다.
 */
export function SettingsModal(props: {
  spec: Extract<DialogSpec, { kind: 'settings' }>;
  onDone: (after?: SettingsAfter) => void;
  onCancel: () => void;
}) {
  useLang();
  const { deps } = props.spec;
  const id = useId();
  // 모르는 쪽 이름이 오면 첫 쪽(일반)을 연다: 고른 탭이 하나도 없으면 탭 목록이 Tab 순서에서 빠진다(rovingGuard.test.tsx)
  const start = rovingStop(SETTINGS_PAGES, props.spec.page) ?? 'general';
  const [page, setPage] = useState<SettingsPage>(start);
  const [seen, setSeen] = useState<ReadonlySet<SettingsPage>>(() => new Set([start]));
  const nav = useRef<HTMLDivElement>(null);
  const integrationCommit = useRef<(() => Promise<void>) | null>(null);
  const closing = useRef(false);
  // 처음 그릴 때의 설정과 테마로 쪽들을 연다(각 쪽이 자기 상태를 들고 바꾼다).
  const initial = useRef({ settings: deps.settings(), theme: deps.theme() }).current;

  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);

  /** 닫는다: 연동 쪽의 남은 칸을 저장한 뒤. `after` 는 닫힌 다음에 openSettings 가 부른다. */
  const finish = async (after?: SettingsAfter) => {
    if (closing.current) return;
    closing.current = true;
    try {
      await integrationCommit.current?.();
    } catch {
      // 저장 실패는 설정 저장이 따로 다룬다: 창은 닫는다
    }
    props.onDone(after);
  };

  const go = (next: SettingsPage, focus = false) => {
    setPage(next);
    setSeen((s) => (s.has(next) ? s : new Set([...s, next])));
    if (focus) nav.current?.querySelectorAll<HTMLElement>('[role="tab"]')[SETTINGS_PAGES.indexOf(next)]?.focus();
  };

  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = SETTINGS_PAGES.indexOf(page);
    const n = SETTINGS_PAGES.length;
    const to =
      e.key === 'ArrowDown' ? (at + 1) % n
      : e.key === 'ArrowUp' ? (at - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    go(SETTINGS_PAGES[to], true);
  };

  const body = (p: SettingsPage) => {
    switch (p) {
      case 'general':
        return <GeneralPage theme={initial.theme} setTheme={deps.setTheme} />;
      case 'editor':
        return <EditorPage settings={initial.settings} update={deps.update} />;
      case 'experiments':
        return <ExperimentsPage settings={initial.settings} update={deps.update} />;
      case 'samples':
        return <SamplesPage deps={deps.samples} leave={(after) => void finish(after)} />;
      case 'integrations':
        return <IntegrationSettingsPage deps={deps.integrations} commitRef={integrationCommit} onLeave={() => finish()} focus={props.spec.focus} />;
      case 'assistant':
        // 스킨 가져오기: 설정 창을 닫고 가져온 뒤 어시스턴트 쪽으로 다시 연다
        return (
          <AssistantPage
            showPage={(next) => go(next, true)}
            llmEndpoint={() => deps.settings().llmEndpointOpenai}
            leave={(after) =>
              void finish(async () => {
                await after();
                await openSettings('assistant');
              })
            }
          />
        );
      case 'shortcuts':
        return <ShortcutsPage />;
      case 'about':
        return <AboutPage version={deps.version} />;
    }
  };

  return (
    <DialogFrame title={t('settings.title')} className="settings-modal" onCancel={() => void finish()}>
      <div className="settings-body">
        <div ref={nav} className="settings-nav" role="tablist" aria-orientation="vertical" aria-label={t('settings.nav')} onKeyDown={onNavKey}>
          {SETTINGS_PAGES.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              id={`${id}-tab-${p}`}
              aria-selected={p === page}
              aria-controls={`${id}-panel-${p}`}
              tabIndex={p === page ? 0 : -1}
              onClick={() => go(p)}
            >
              <Icon name={PAGE_ICON[p]} size={16} />
              <span>{PAGE_LABEL[p]()}</span>
            </button>
          ))}
        </div>
        <div className="settings-pane">
          {SETTINGS_PAGES.filter((p) => seen.has(p)).map((p) => (
            <section
              key={p}
              role="tabpanel"
              id={`${id}-panel-${p}`}
              aria-labelledby={`${id}-tab-${p}`}
              className={`settings-page settings-page-${p}`}
              hidden={p !== page}
            >
              <h3 className="settings-page-title">{PAGE_LABEL[p]()}</h3>
              {body(p)}
            </section>
          ))}
        </div>
      </div>
    </DialogFrame>
  );
}
