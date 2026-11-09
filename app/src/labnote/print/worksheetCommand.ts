/**
 * "실험 워크시트 출력"의 앱 배선(플러그인 barcodeFeature.worksheetDeps 의 앱판): 명령 맥락에서 WorksheetDeps 를 만든다.
 * - 읽기는 편집기를 아는 fs(열린 노트는 버퍼)로, 용지는 설정(worksheetPaperSize)으로.
 * - 노트 ID 는 노트 ID 색인 위의 NoteIdService.ensureId: 쓰기는 processNote 이고, 한글 조합 중인 열린 노트는
 *   NoteBusyError 로 아무것도 쓰지 않는다(runCommand 가 알린다).
 * - 샘플 위치는 그 노트가 샘플을 추적할 때만: 노트의 Local 폴더, 다음 Global 폴더 차례로 읽는다(#496).
 * - 출력은 본 웹뷰의 인쇄 루트(printPages), 브라우저는 Rust 의 print_open_in_browser.
 */
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import { isSameSampleFolder, loadSampleLocationLookup, noteLabsamplesFolder } from '@labnoteo/core/lib/sampleStorage';
import { createSampleEnv } from '../../samples/env';
import { noteIds } from '../barcode/noteIdIndex';
import { appNoteIdSource, noteRef } from '../barcode/noteIdSource';
import type { CommandContext } from '../commands/context';
import { worksheetDialog } from '../host/dialogStore';
import { NoteIdService } from '../port/noteIdService';
import type { WorksheetDeps } from '../port/worksheetPrint';
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
