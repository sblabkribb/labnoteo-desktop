/**
 * "실험 워크시트 출력"의 앱 배선(플러그인 barcodeFeature.worksheetDeps 의 앱판): 명령 맥락에서 WorksheetDeps 를 만든다.
 * - 읽기는 편집기를 아는 fs(열린 노트는 버퍼)로, 용지는 설정(worksheetPaperSize)으로.
 * - 노트 ID 는 노트 ID 색인 위의 NoteIdService.ensureId: 쓰기는 processNote 이고, 한글 조합 중인 열린 노트는
 *   NoteBusyError 로 아무것도 쓰지 않는다(runCommand 가 알린다).
 * - 샘플 위치는 그 노트가 샘플을 추적할 때만: 노트의 Local 폴더, 다음 Global 폴더 차례로 읽는다(#496).
 * - 출력은 본 웹뷰의 인쇄 루트(printPages), 브라우저는 Rust 의 print_open_in_browser.
 * - 노트 전체 인쇄(fullNoteDeps)는 같은 의존성에 재기(measureNoteBlocks)와 그 인쇄 작업 하나의 이미지를 더한다:
 *   이미지 문단의 임베드를 편집기 규칙(resolveNoteImages)으로 찾아 vault_read_image 로 읽고 blob: URL 을 만든다.
 *   브라우저 파일은 그 바이트를 data: 로 넣고, 작업이 끝나면 URL 을 거둔다.
 */
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import { isSameSampleFolder, loadSampleLocationLookup, noteLabsamplesFolder } from '@labnoteo/core/lib/sampleStorage';
import { MIME, extOf } from '../../editor/live/imagePath';
import { listVaultImages, readVaultImage } from '../../fs/vaultImage';
import { createSampleEnv } from '../../samples/env';
import { noteIds } from '../barcode/noteIdIndex';
import { appNoteIdSource, noteRef } from '../barcode/noteIdSource';
import type { CommandContext } from '../commands/context';
import { worksheetDialog } from '../host/dialogStore';
import { NoteIdService } from '../port/noteIdService';
import type { FullNoteDeps, PrintImages } from '../port/fullNotePrint';
import type { WorksheetDeps } from '../port/worksheetPrint';
import { measureNoteBlocks } from './measure';
import { resolveNoteImages } from './noteBlocks';
import { openInBrowser } from './openInBrowser';
import { printPages } from './printRoot';

/** 그 경로 노트의 ID. 없으면 하나 주고 돌려준다. 앞부분을 읽을 수 없거나 사용자가 취소하면 undefined. */
async function ensureNoteId(ctx: CommandContext, path: string): Promise<string | undefined> {
  const index = noteIds();
  await index.ready();
  const service = new NoteIdService(appNoteIdSource(index, ctx.host.fs), ctx.host);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const ref = noteRef(index, path) ?? { path, basename: name.replace(/\.md$/, ''), ctime: 0 };
  return service.ensureId(ref);
}

export function worksheetDeps(ctx: CommandContext): WorksheetDeps {
  return {
    host: ctx.host,
    t: ctx.host.t,
    read: (path) => ctx.host.fs.read(path),
    paper: () => ctx.settings.worksheetPaperSize,
    setPaper: async (paper) => ctx.updateSettings({ worksheetPaperSize: paper }),
    ensureNoteId: (path) => ensureNoteId(ctx, path),
    sampleLookup: async (path) => {
      const env = createSampleEnv(ctx);
      if (!env.trackingFor(path)) return undefined;
      const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
      const global = env.globalFolder();
      const local = noteLabsamplesFolder(path, global);
      const folders = isSameSampleFolder(local, global) ? [local] : [local, global];
      return { types, lookup: await loadSampleLocationLookup(env.fs, folders, types) };
    },
    choose: (unitOps, paper) => worksheetDialog(unitOps, paper),
    print: (pages, paper) => printPages(pages, paper),
    openInBrowser: async (kind, noteId, html) => {
      await openInBrowser(kind, noteId, html);
    },
  };
}

/**
 * 인쇄 작업 하나의 이미지: 노트 `path` 의 이미지 문단마다 보관함에서 읽어 blob: URL 을 만든다. `blob(src)` 은 이 작업이
 * 만든 URL 의 바이트만 돌려주고(브라우저 파일의 data: 이미지), `release()` 가 URL 을 모두 거둔다.
 * 이미지가 아니거나 20 MiB 를 넘으면 Rust 가 거부하고, 그 임베드는 `[이름]` 으로 찍힌다.
 */
export async function noteImagesFor(
  path: string,
  md: string,
  io: {
    read: (vaultPath: string) => Promise<ArrayBuffer>;
    list: () => Promise<string[]>;
    urls?: { create(b: Blob): string; revoke(u: string): void };
  } = { read: (p) => readVaultImage(p), list: () => listVaultImages() },
): Promise<PrintImages> {
  const urls = io.urls ?? { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) };
  const blobs = new Map<string, Blob>();
  const load = async (vaultPath: string): Promise<string> => {
    const blob = new Blob([await io.read(vaultPath)], { type: MIME[extOf(vaultPath)] ?? 'application/octet-stream' });
    const url = urls.create(blob);
    blobs.set(url, blob);
    return url;
  };
  const release = (): void => {
    for (const url of blobs.keys()) urls.revoke(url);
    blobs.clear();
  };
  try {
    const images = await resolveNoteImages(md, path, load, io.list);
    return { src: (target, kind) => images.src(target, kind), blob: async (src) => blobs.get(src), release };
  } catch (e) {
    release();
    throw e;
  }
}

/** "노트 전체를 바코드와 함께 출력"의 의존성: 워크시트의 것에 재기와 이미지를 더한다. */
export function fullNoteDeps(ctx: CommandContext): FullNoteDeps {
  return {
    ...worksheetDeps(ctx),
    measure: (blocks, paper) => measureNoteBlocks(blocks, paper),
    images: (path, md) => noteImagesFor(path, md),
  };
}
