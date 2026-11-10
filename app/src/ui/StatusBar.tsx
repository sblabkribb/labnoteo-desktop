import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { useEditorLoaded, useEditorStatus, type SaveState } from '../editor/editorStatus';
import { Icon, type IconName } from './Icon';
import { useNotePosition } from './Breadcrumb';
import { useViewerStatus } from '../viewers/viewerStatus';

/** 저장 상태의 아이콘과 글. */
function saveView(save: SaveState): { icon: IconName; text: string; title?: string; tone?: 'danger' | 'warning' } | undefined {
  switch (save) {
    case 'saved':
      return { icon: 'circle-check', text: t('statusbar.saved') };
    case 'dirty':
      return { icon: 'circle-dot', text: t('editor.dirty') };
    case 'saving':
      return { icon: 'loader', text: t('statusbar.saving') };
    case 'error':
      return { icon: 'circle-x', text: t('statusbar.saveFailed'), title: t('editor.saveError'), tone: 'danger' };
    case 'conflict':
      return { icon: 'triangle-alert', text: t('statusbar.conflict'), title: t('editor.conflicted'), tone: 'warning' };
    default:
      return undefined;
  }
}

/** 구조 위치: `WT020 · UO 1/2 완료`, README 면 `003 · 워크플로 1/3`. 그 밖의 노트는 없다. */
function PositionItem(p: { path: string; onReveal: () => void }) {
  const pos = useNotePosition(p.path);
  // 편집기가 본문을 내기 전(읽는 중)에는 세지 않은 0/0 을 보이지 않는다
  const loaded = useEditorLoaded(p.path);
  if (!loaded) return null;
  const text =
    pos.kind === 'workflow' ? `${pos.workflow.id} · ${t('statusbar.uoProgress', pos.uoDone, pos.uoTotal)}`
    : pos.kind === 'readme' ? `${pos.experiment.code} · ${t('statusbar.wfProgress', pos.wfDone, pos.wfTotal)}`
    : undefined;
  if (text === undefined) return null;
  return (
    <button type="button" className="statusbar-item statusbar-button statusbar-position" title={t('statusbar.reveal')} onClick={p.onReveal}>
      <Icon name={pos.kind === 'workflow' ? 'workflow' : 'flask-conical'} size={14} />
      <span>{text}</span>
    </button>
  );
}

/** 편집기의 저장 상태, 줄·열, 단어 수. 편집기가 아직 내지 않았으면 그리지 않는다. */
function EditorItems(p: { path: string }) {
  const s = useEditorStatus(p.path);
  if (!s) return null;
  const save = saveView(s.save);
  return (
    <>
      {save && (
        <span className="statusbar-item statusbar-save" role="status" data-tone={save.tone} title={save.title}>
          <Icon name={save.icon} size={14} className={s.save === 'saving' ? 'spin' : undefined} />
          <span>{save.text}</span>
        </span>
      )}
      <span className="statusbar-item">{t('statusbar.lineCol', s.line, s.col)}</span>
      <span className="statusbar-item">{t('statusbar.words', s.words.toLocaleString())}</span>
    </>
  );
}

/** 보기 화면(그림, 표)의 칸: 그림은 픽셀 크기·바이트·배율, 표는 행×열·인코딩·구분자. */
function ViewerItems(p: { path: string }) {
  const items = useViewerStatus(p.path);
  return (
    <>
      {items.map((text, i) => (
        <span key={i} className="statusbar-item">
          {text}
        </span>
      ))}
    </>
  );
}

/**
 * 창 아래 상태 줄(26px): 맨 앞에 업데이트 버튼(leading), 구조 위치, 저장 상태, 줄·열, 단어 수, 그리고 앱 알림(색인 중 등). 오른쪽 끝에 모양 단추(appearance).
 * 맞지 않는 칸은 숨긴다.
 */
export function StatusBar(p: {
  path?: string;
  viewerPath?: string;
  onReveal: () => void;
  /** 맨 앞 칸(창의 왼쪽 아래): 업데이트 버튼. */
  leading?: ReactNode;
  notes?: ReactNode;
  trailing?: ReactNode;
}) {
  useLang();
  return (
    <footer className="statusbar" aria-label={t('statusbar.label')}>
      <div className="statusbar-group">
        {p.leading}
        {p.path !== undefined && <PositionItem path={p.path} onReveal={p.onReveal} />}
        {p.path !== undefined && <EditorItems path={p.path} />}
        {p.viewerPath !== undefined && <ViewerItems path={p.viewerPath} />}
        {p.notes}
      </div>
      <div className="statusbar-group statusbar-end">{p.trailing}</div>
    </footer>
  );
}
