import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { treeIcon, type FileKind } from '../labnote/panel/treeIcons';
import { Icon } from '../ui/Icon';

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
 * 노트가 아닌 파일(그림, 표, PDF, 그 밖의 첨부)을 파일 탭에서 고르면 본문에 보이는 카드: 이름, 위치, 종류.
 * 파일을 읽지 않는다(텍스트 vault_read 는 노트만). 그림·표 보기 화면은 Task 18 이 이 자리에 붙인다.
 */
export function FileCard({ path, kind }: { path: string; kind: FileKind }) {
  useLang();
  const at = path.lastIndexOf('/');
  const name = path.slice(at + 1);
  const folder = at > 0 ? path.slice(0, at) : '';
  const icon = treeIcon(kind) ?? 'paperclip';
  return (
    <article className="file-card" aria-label={t('fileCard.label')}>
      <Icon name={icon} size={18} className="file-card-icon" />
      <h2 className="file-card-name">{name}</h2>
      <dl className="file-card-facts">
        <dt>{t('fileCard.folder')}</dt>
        <dd>{folder || t('fileCard.root')}</dd>
        <dt>{t('fileCard.kind')}</dt>
        <dd>{kindLabel(kind)}</dd>
      </dl>
      <p className="file-card-hint">{t('fileCard.hint')}</p>
    </article>
  );
}
