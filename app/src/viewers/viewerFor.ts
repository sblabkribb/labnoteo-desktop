import { IMAGE_EXTS } from '../editor/live/imagePath';
import { extOf } from '../labnote/panel/treeIcons';

/** 노트가 아닌 파일을 어느 화면으로 보이나: 그림(`vault_read_image` 가 읽는 확장자), CSV·TSV 표, 나머지는 파일 카드. */
export function viewerFor(path: string): 'image' | 'csv' | 'card' {
  const ext = extOf(path.slice(path.lastIndexOf('/') + 1));
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  return 'card';
}
