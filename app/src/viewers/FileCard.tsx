import { useEffect, useState } from 'react';
import { fileInfo, type VaultFileInfo } from '../fs/vaultOpen';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { treeIcon, type FileKind } from '../labnote/panel/treeIcons';
import { Icon } from '../ui/Icon';
import { FileActions } from './fileActions';
import { formatBytes } from './viewerStatus';

/** 수정 시각을 `YYYY-MM-DD HH:mm`(이 PC 의 시각)로. */
export function formatModified(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 노트가 아닌 파일의 종류 이름. */
function kindLabel(kind: FileKind): string {
  switch (kind) {
    case 'image':
      return t('fileKind.image');
    case 'sheet':
      return t('fileKind.sheet');
    case 'pdf':
      return t('fileKind.pdf');
    case 'json':
      return t('fileKind.json');
    default:
      return t('fileKind.other');
  }
}

/**
 * 앱 안에 보기 화면이 없는 파일(PDF, Excel, 그 밖의 첨부)을 고르면 본문에 보이는 카드: 이름, 위치, 종류, 크기, 수정한 날
 * (명세 §6.1, Rust `vault_file_info`), 그리고 기본 앱으로 열기·폴더에서 보기(둘 다 Rust 가 연다, R7). 파일 내용은 읽지 않는다.
 * 그림·표 보기가 파일을 읽지 못했으면(너무 큼 등) 그 이유(`reason`)를 실어 같은 카드를 보인다.
 */
export function FileCard({ path, kind, reason }: { path: string; kind: FileKind; reason?: string }) {
  useLang();
  const at = path.lastIndexOf('/');
  const name = path.slice(at + 1);
  const folder = at > 0 ? path.slice(0, at) : '';
  const icon = treeIcon(kind) ?? 'paperclip';
  const [info, setInfo] = useState<VaultFileInfo | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fileInfo(path)
      .then((i) => {
        if (live) setInfo(i);
      })
      .catch(() => undefined); // 크기를 모르면 그 줄만 빠진다
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <article className="file-card" aria-label={t('fileCard.label')}>
      <Icon name={icon} size={18} className="file-card-icon" />
      <h2 className="file-card-name">{name}</h2>
      <dl className="file-card-facts">
        <dt>{t('fileCard.folder')}</dt>
        <dd>{folder || t('fileCard.root')}</dd>
        <dt>{t('fileCard.kind')}</dt>
        <dd>{kindLabel(kind)}</dd>
        {info ? (
          <>
            <dt>{t('fileCard.size')}</dt>
            <dd>{formatBytes(info.size, t)}</dd>
          </>
        ) : null}
        {info?.modified != null ? (
          <>
            <dt>{t('fileCard.modified')}</dt>
            <dd>{formatModified(info.modified)}</dd>
          </>
        ) : null}
      </dl>
      {reason !== undefined ? (
        <p className="file-card-hint file-card-reason" role="status">
          {reason}
        </p>
      ) : (
        <p className="file-card-hint">{t('fileCard.hint')}</p>
      )}
      <FileActions path={path} />
    </article>
  );
}
