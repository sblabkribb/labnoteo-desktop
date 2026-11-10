import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import type { ImageFolder } from '../../labnote/settings';

/**
 * 노트에 붙여 넣거나 끌어 놓은 파일이 갈 곳과 넣을 링크(UI 재설계 Task 17, 스펙 §6).
 * - 그림이 아닌 첨부는 실험 폴더의 `resources/` 로 간다(실험 밖의 노트면 노트 폴더의 `resources/`).
 * - 그림은 설정 `imageFolder` 를 따른다: 기본 'resources'(위와 같은 곳), 'images' 면 노트 폴더의 `images/`(Obsidian·플러그인과 같다).
 * - Rust `vault_write_attachment` 가 폴더(마지막 조각이 resources, labsamples·workflows 아님), 이름, 막힌 확장자, 크기를 다시 본다.
 */

/** Rust `MAX_ATTACHMENT_BYTES` 와 같은 상한(100 MiB). 넘는 파일은 읽기 전에 거른다. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * 첨부로 저장하지 않는 확장자(실행 파일, 스크립트, 바로 가기, 매크로 문서, 디스크 이미지).
 * Rust `vault/attach.rs` 의 `BLOCKED_EXTS` 와 같아야 한다(attachments.test.ts 가 그 파일을 읽어 비교한다).
 */
export const BLOCKED_EXTS: readonly string[] = [
  // executables, installers and packages
  'exe', 'msi', 'msp', 'msu', 'msix', 'msixbundle', 'appx', 'appxbundle', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys',
  'ocx', 'drv', 'cab', 'diagcab', 'application', 'appref-ms', 'gadget', 'jar', 'jnlp', 'xll', 'xbap', 'vsix',
  // Windows scripts and script hosts
  'bat', 'cmd', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psm1', 'psd1', 'pssc', 'cdxml', 'msh', 'msh1',
  'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'vb', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'ws', 'wsf', 'wsh', 'wsc', 'sct', 'hta',
  'mht', 'mhtml', 'html', 'htm', 'xhtml', 'xht', 'shtml', 'svgz', 'shb', 'shs', 'inf', 'ins', 'isp', 'reg', 'msc', 'mmc', 'mst', 'mcf',
  // other interpreters
  'py', 'pyw', 'pyz', 'pyzw', 'pyc', 'pyo', 'sh', 'bash', 'zsh', 'ksh', 'csh', 'pl', 'pm', 'rb', 'rbw', 'php', 'tcl',
  'lua', 'r', 'command', 'tool', 'vbproj', 'csproj',
  // shortcuts, shell and settings handlers
  'lnk', 'url', 'scf', 'website', 'library-ms', 'search-ms', 'searchconnector-ms', 'settingcontent-ms', 'theme',
  'themepack', 'deskthemepack', 'rdp', 'chm', 'hlp', 'grp', 'fxp', 'prf', 'prg', 'crt', 'der', 'cer', 'its',
  // Access and Office macro containers
  'ade', 'adp', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav', 'maw', 'mda', 'mdb', 'mde',
  'mdt', 'mdw', 'mdz', 'accda', 'accdb', 'accde', 'accdr', 'accdt', 'laccdb', 'docm', 'dotm', 'xlsm', 'xltm', 'xlam',
  'xla', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
  // disk images
  'iso', 'img', 'vhd', 'vhdx',
];

const lastExt = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** 마지막 확장자가 막힌 것인가(대소문자 무시). */
export function isBlockedName(name: string): boolean {
  const ext = lastExt(name);
  return ext !== '' && BLOCKED_EXTS.includes(ext);
}

/** 노트가 든 폴더('' 는 보관함 루트). */
const noteDirOf = (notePath: string): string => {
  const slash = notePath.lastIndexOf('/');
  return slash < 0 ? '' : notePath.slice(0, slash);
};
const join = (dir: string, child: string) => (dir ? `${dir}/${child}` : child);

/** 그림이 아닌 첨부의 폴더: 노트가 든 실험의 `resources`, 실험 밖이면 노트 폴더의 `resources`. */
export function attachmentDir(notePath: string, experimentDirOf: (p: string) => string | undefined = getExperimentDir): string {
  return join(experimentDirOf(notePath) ?? noteDirOf(notePath), 'resources');
}

/** 그림의 폴더: 설정이 'images' 면 노트 폴더의 `images`, 아니면(기본) 첨부와 같은 `resources`. */
export function imageDir(
  notePath: string,
  setting: ImageFolder,
  experimentDirOf: (p: string) => string | undefined = getExperimentDir,
): string {
  return setting === 'images' ? join(noteDirOf(notePath), 'images') : attachmentDir(notePath, experimentDirOf);
}

/** 알림과 끌어 놓기 안내에 보일 폴더 이름: 마지막 조각과 '/'(`resources/`, `images/`). */
export function folderLabel(dir: string): string {
  return `${dir.slice(dir.lastIndexOf('/') + 1)}/`;
}

const IMAGE_LINK_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'];

/**
 * 쓴 파일 `rel` 에 넣을 링크. 이름이 보관함에서 하나뿐이면 이름만, 아니면 보관함 경로.
 * 그림과 PDF 는 임베드(`![[…]]`), 나머지는 링크(`[[…]]`).
 */
export function linkFor(rel: string, unique: boolean): string {
  const target = unique ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
  const ext = lastExt(rel);
  const embed = ext === 'pdf' || IMAGE_LINK_EXTS.includes(ext);
  return `${embed ? '!' : ''}[[${target}]]`;
}

/** Windows 예약 이름(확장자 앞의 첫 조각으로 판단, Rust `is_safe_component` 와 같다). */
const RESERVED = /^(con|conin\$|conout\$|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** 이름에 쓸 수 없는 글자: 제어 문자, Windows 가 막는 글자, 위키 링크를 깨는 글자(`[ ] | # ^`). */
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f\\/:<>"|?*[\]#^]/g;

const pad = (n: number) => String(n).padStart(2, '0');

/** 이름을 쓸 수 없을 때의 이름(붙여 넣은 그림과 같은 꼴, 현지 시각): `Pasted file 20261110093000.csv`. */
export function pastedFileName(now: Date, ext: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted file ${stamp}${ext ? `.${ext}` : ''}`;
}

/**
 * 첨부 파일의 저장 이름: 경로를 떼고, 쓸 수 없는 글자는 `_` 로, 끝의 점·공백은 지운다. 점으로 시작하거나
 * 예약 이름이거나 비면 `pastedFileName`. 확장자는 그대로 둔다(막힌 확장자는 부르는 쪽이 먼저 거른다).
 */
export function attachmentName(raw: string, now: Date): string {
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  const cleaned = base.replace(BAD_CHARS, '_').replace(/[. ]+$/, '').trim();
  const ext = lastExt(cleaned);
  if (cleaned === '' || cleaned.startsWith('.') || RESERVED.test(cleaned.split('.')[0].trimEnd())) {
    return pastedFileName(now, /^[a-z0-9]{1,10}$/.test(ext) ? ext : '');
  }
  return cleaned;
}
