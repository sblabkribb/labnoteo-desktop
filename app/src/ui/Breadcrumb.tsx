import { useMemo, type MouseEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { useEditorLoaded, useEditorText } from '../editor/editorStatus';
import { notePosition, type NotePosition } from '../labnote/notePosition';
import { STATUS_SHAPE_ICON as SHAPE_ICON, statusLabel, statusShape } from '../labnote/statusLabels';
import type { MenuItem } from '../labnote/ui/menuStore';
import { Icon } from './Icon';

/** 열린 노트의 구조 위치(편집기가 낸 본문에서 읽는다; 본문이 바뀔 때만 다시 계산한다). */
export function useNotePosition(path: string): NotePosition {
  const text = useEditorText(path);
  return useMemo(() => notePosition(path, text), [path, text]);
}

/**
 * 상태 칩: 지역화한 이름과 모양 아이콘. `onClick` 이 있으면(실험 README) 눌러서 상태를 바꾸는 단추다.
 * 저장 값(`in-progress`)은 그대로 두고 그리기만 바꾼다.
 */
export function StatusChip(p: { status: string; onClick?: () => void }) {
  useLang();
  const label = statusLabel(p.status);
  const shape = statusShape(p.status);
  const body = (
    <>
      <Icon name={SHAPE_ICON[shape]} size={14} />
      <span className="btn-label-collapsible">{label}</span>
    </>
  );
  return p.onClick ? (
    <button
        type="button"
        className="chip status"
        data-shape={shape}
        data-command-id="change-experiment-status"
        title={t('header.statusChange', label)}
        onClick={p.onClick}
      >
      {body}
    </button>
  ) : (
    <span className="chip status" data-shape={shape} title={t('header.status', label)}>
      {body}
    </span>
  );
}

interface CrumbProps {
  position: NotePosition;
  /** 경로의 노트를 연다(실험 → README). */
  onOpen: (path: string) => void;
  /** UO 메뉴를 연다(단추 아래). 항목을 고르면 그 제목 줄(0부터)로 간다. */
  onMenu: (anchor: Element, items: MenuItem[]) => void;
  /** 그 줄(0부터)로 커서를 옮긴다. */
  onJump: (line: number) => void;
  /** 실험 상태 바꾸기(README 의 상태 칩). 없으면 칩은 단추가 아니다. */
  onStatus?: () => void;
  /** 본문을 다 읽었다. 아니면(읽는 중) 세지 않은 칩(상태, 워크플로 0/0)을 그리지 않는다. 기본 true. */
  loaded?: boolean;
}

/**
 * 보기 머리의 경로: 워크플로 노트는 `실험 › 워크플로 ▾`(마지막 칸은 UO 메뉴), README 는 `실험` 과 "워크플로 1/3" 칩,
 * 그 밖의 노트는 폴더 경로와 제목. 상태 칩이 옆에 붙는다.
 */
export function Breadcrumb(p: CrumbProps) {
  useLang();
  const pos = p.position;
  const loaded = p.loaded ?? true;
  const sep = (
    <li className="crumb-sep" aria-hidden="true">
      <Icon name="chevron-right" size={14} />
    </li>
  );
  if (pos.kind === 'workflow') {
    const items: MenuItem[] =
      pos.uos.length === 0
        ? [{ label: t('header.noUo'), disabled: true, run: async () => undefined }]
        : // 다른 메뉴와 같은 줄(명세 §3.4): 완료 표시 아이콘, 별칭, 오른쪽 끝에 고정폭 코드
          pos.uos.map((u) => ({
            label: u.alias || u.name,
            icon: u.done ? ('circle-check' as const) : ('circle-dot' as const),
            shortcut: u.id,
            run: async () => p.onJump(u.line),
          }));
    const exp = pos.experiment;
    return (
      <>
        <nav className="breadcrumb" aria-label={t('header.breadcrumb')}>
          <ol>
            <li>
              <button type="button" className="crumb" onClick={() => p.onOpen(exp.readme)}>
                {crumbExperiment(exp.code, exp.title)}
              </button>
            </li>
            {sep}
            <li>
              <button
                type="button"
                className="crumb crumb-last"
                aria-current="page"
                aria-haspopup="menu"
                title={t('header.uoMenu')}
                onClick={(e: MouseEvent<HTMLButtonElement>) => p.onMenu(e.currentTarget, items)}
              >
                <span className="crumb-code">{pos.workflow.id}</span>
                <span className="crumb-text">{pos.workflow.title}</span>
                <Icon name="chevron-down" size={14} />
              </button>
            </li>
          </ol>
        </nav>
        {loaded && pos.uoTotal > 0 && (
          <span className="chip code" title={t('header.uoChip.tip')}>
            {t('header.uoChip', pos.uoDone, pos.uoTotal)}
          </span>
        )}
      </>
    );
  }
  if (pos.kind === 'readme') {
    const exp = pos.experiment;
    return (
      <>
        <nav className="breadcrumb" aria-label={t('header.breadcrumb')}>
          <ol>
            <li>
              <span className="crumb crumb-last" aria-current="page">
                {crumbExperiment(exp.code, exp.title)}
              </span>
            </li>
          </ol>
        </nav>
        {loaded && <span className="chip code">{t('header.wfChip', pos.wfDone, pos.wfTotal)}</span>}
        {loaded && pos.status !== undefined && <StatusChip status={pos.status} onClick={p.onStatus} />}
      </>
    );
  }
  const folders = pos.folder === '' ? [] : pos.folder.split('/');
  return (
    <nav className="breadcrumb" aria-label={t('header.breadcrumb')}>
      <ol>
        {folders.map((f, i) => (
          <li key={`${i}:${f}`} className="crumb-folder-item">
            <span className="crumb crumb-folder">{f}</span>
            <span className="crumb-sep" aria-hidden="true">
              <Icon name="chevron-right" size={14} />
            </span>
          </li>
        ))}
        <li>
          <span className="crumb crumb-last" aria-current="page">
            {pos.title}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function crumbExperiment(code: string, title: string) {
  return (
    <>
      {code !== '' && <span className="crumb-code">{code}</span>}
      <span className="crumb-text">{title}</span>
    </>
  );
}

/** 편집기 머리의 경로 칸: 열린 노트의 위치를 편집기가 낸 본문에서 읽어 Breadcrumb 으로 그린다. */
export function NoteLead(p: Omit<CrumbProps, 'position'> & { path: string }) {
  const position = useNotePosition(p.path);
  const loaded = useEditorLoaded(p.path);
  return <Breadcrumb {...p} position={position} loaded={loaded} />;
}
