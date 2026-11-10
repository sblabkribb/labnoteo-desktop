/**
 * 트리 아이콘과 파일 종류. 모든 트리(파일, 실험, 샘플, 개요)는 TreeNode.icon 의 이름을 여기서 Lucide 아이콘(ui/Icon.tsx)으로
 * 바꿔 그린다. 이름은 코어 트리 모델의 것(buildExperimentTree, buildWorkflowTree: VS Code codicon 이름)과 파일 탭의 파일 종류(FileKind)다.
 * 모르는 이름은 아이콘 없이(빈 자리) 그린다.
 */
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import type { IconName } from '../../ui/Icon';
import { README } from '../paths';

/** 파일 탭의 줄 종류(spec 4.2). */
export type FileKind = 'folder' | 'experiment' | 'readme' | 'workflow' | 'note' | 'image' | 'sheet' | 'pdf' | 'json' | 'other';

/** 아이콘 이름 -> Lucide. 코어 이름(플러그인 treeRender.ts 의 ICON_MAP 과 같은 뜻)과 파일 종류. */
export const TREE_ICONS: Readonly<Record<string, IconName>> = Object.freeze({
  // 코어 트리 모델
  beaker: 'flask-conical',
  folder: 'folder',
  file: 'file-text',
  warning: 'triangle-alert',
  'comment-discussion': 'pencil',
  'symbol-class': 'workflow',
  'symbol-method': 'circle-dot',
  'symbol-function': 'code',
  // 실험 탭(experimentTree): 끝난 UO, 추가 줄
  'uo-done': 'circle-check',
  add: 'plus',
  // 샘플 탭(samples/SamplesPanel.tsx): 종류 줄과 샘플 줄
  'test-tube': 'test-tube',
  sample: 'tag',
  // 파일 종류
  experiment: 'flask-conical',
  readme: 'flask-conical',
  workflow: 'workflow',
  note: 'file-text',
  image: 'image',
  sheet: 'sheet',
  pdf: 'file-type',
  json: 'braces',
  other: 'paperclip',
});

/** 줄의 아이콘. 펼친 폴더는 folder-open 이다. */
export function treeIcon(icon: string | undefined, open = false): IconName | undefined {
  if (icon === undefined || !Object.hasOwn(TREE_ICONS, icon)) return undefined;
  if (open && icon === 'folder') return 'folder-open';
  return TREE_ICONS[icon];
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);
const SHEET = new Set(['csv', 'tsv', 'xlsx', 'xls']);

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** 마지막 점 뒤(맨 앞의 점은 확장자가 아니다), 소문자. 없으면 ''. Rust TreeEntry.ext 와 같은 규칙. */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

/** 노트(편집기로 여는 파일): `.md` 로 끝나는 파일(대소문자 무관). */
export const isNotePath = (path: string): boolean => /.\.md$/i.test(baseName(path));

/**
 * 보관함 상대 경로의 종류. 폴더는 `isDir` 로 알린다.
 * - 실험 폴더: `labnote/###_…`(코어 getExperimentDir), 그 바로 안의 README.labnote.md 는 readme, 다른 .labnote.md 는 workflow.
 * - 그 밖의 .md 는 note, 나머지는 확장자로 image / sheet / pdf / json / other.
 */
export function fileKind(path: string, isDir = false): FileKind {
  if (isDir) return getExperimentDir(path) === path ? 'experiment' : 'folder';
  const name = baseName(path);
  if (isNotePath(name)) {
    const parent = dirName(path);
    if (parent === '' || getExperimentDir(path) !== parent || !/\.labnote\.md$/.test(name)) return 'note';
    return name === README ? 'readme' : 'workflow';
  }
  const ext = extOf(name);
  if (IMAGE.has(ext)) return 'image';
  if (SHEET.has(ext)) return 'sheet';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'json') return 'json';
  return 'other';
}

/** 앱 안에 보기 화면이 있는 종류(그림, 표). 나머지 첨부는 파일 카드와 기본 앱으로 연다. */
export const hasViewer = (kind: FileKind): boolean => kind === 'image' || kind === 'sheet';

/** 줄에 그리는 이름: `.labnote.md`, 그다음 `.md` 를 뗀다. 이름 전체가 확장자뿐이면 그대로 둔다. 전체 이름은 title 로 본다. */
export function displayName(name: string): string {
  const stem = /\.labnote\.md$/i.test(name) ? name.slice(0, -'.labnote.md'.length) : /\.md$/i.test(name) ? name.slice(0, -'.md'.length) : name;
  return stem === '' || stem.startsWith('.') ? name : stem;
}
