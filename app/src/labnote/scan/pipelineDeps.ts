/**
 * 스캔 파이프라인(port/scanPipeline.ts)의 앱 배선: 명령 맥락에서 PipelineDeps 를 만든다.
 * - 노트 찾기는 노트 ID 색인 위의 NoteIdService(첫 빌드를 run 이 기다린다: `ready`).
 * - 읽기는 편집기를 아는 fs(열린 노트는 버퍼), 쓰기는 processNote 다: 노트마다 한 번, 한글 조합 중이거나 바쁜 열린 노트는
 *   NoteBusyError 로 아무것도 쓰지 않고, 파이프라인이 1 초마다 30 초까지 다시 해 본 뒤 그 페이지를 미분류 대기열로 보낸다(B9).
 * - 이미지는 scan_write_image(이름 그대로, 겹치면 `exists`), vault_exists, vault_read_image, 링크 색인의 백링크로.
 *   새 스캔 이미지를 쓴 뒤에는 편집기의 이미지 이름 색인을 버린다: 이름만 쓴 임베드가 곧바로 그 파일을 찾는다.
 * - 날짜 찍기(stampNote)는 같은 processNote 변환 안에서: 설정 autoUpdateLastUpdated 가 켜져 있고 `*.labnote.md` 일 때만.
 *   워크플로 노트면 실험 README 의 날짜도 2 초 뒤 찍는다(Task 20: autoUpkeep 의 markUserEdit, 손으로 정한 날짜는 둔다).
 * - 페이지 해독기(PageDecoder)는 부르는 쪽이 준다(캔버스 해독기는 pageDecoder.ts).
 */
import { vaultImages } from '../../editor/live/vaultImages';
import { listVaultImages, readVaultImage, writeScanImage } from '../../fs/vaultImage';
import { linkIndex } from '../../links/linkIndex';
import { noteIds } from '../barcode/noteIdIndex';
import { appNoteIdSource } from '../barcode/noteIdSource';
import type { CommandContext } from '../commands/context';
import { appUpkeep } from '../commands/autoUpkeep';
import { readmeStamp } from '../commands/stamp';
import { processNote } from '../openNotes';
import { NoteIdService, isBarcodeNote } from '../port/noteIdService';
import type { PageDecoder, PipelineDeps } from '../port/scanPipeline';
import type { AppSettings } from '../settings';

const identity = (text: string) => text;

/**
 * 스캔을 넣은 노트의 날짜 찍기(플러그인 markUserEdit 의 앱판, B9): 설정이 켜져 있고 랩 노트(`*.labnote.md`)이면
 * `last_updated_date` 를 오늘(서울)로 바꾸는 변환, 아니면 그대로.
 */
export function noteStamp(settings: Pick<AppSettings, 'autoUpdateLastUpdated'>): (path: string) => (text: string) => string {
  return (path) => (settings.autoUpdateLastUpdated && isBarcodeNote(path) ? readmeStamp(settings as AppSettings) : identity);
}

/** 명령 맥락의 PipelineDeps. 설정은 부를 때마다 지금 값을 읽는다. */
export function pipelineDeps(ctx: CommandContext, decoder: PageDecoder): PipelineDeps {
  const fs = ctx.host.fs;
  let service: NoteIdService | undefined;
  return {
    host: ctx.host,
    t: ctx.host.t,
    // 색인은 보관함을 연 뒤에 생긴다: 처음 쓸 때 만든다.
    get noteIds() {
      service ??= new NoteIdService(appNoteIdSource(noteIds(), fs), ctx.host);
      return service;
    },
    ready: () => noteIds().ready(),
    fs,
    processNote: (path, fn) => processNote(fs, path, fn),
    images: {
      exists: (path) => fs.exists(path),
      readBinary: (path) => readVaultImage(path),
      async writeScanImage(dir, name, bytes) {
        const path = await writeScanImage(dir, name, bytes);
        vaultImages.index.invalidate();
        return path;
      },
      backlinks: (path) => (ctx.links?.index ?? linkIndex).backlinks(path),
    },
    listImages: () => listVaultImages(),
    decoder,
    embedWidth: () => ctx.settings.scanEmbedWidth,
    stampNote: (path) => {
      const stamp = noteStamp(ctx.settings)(path);
      return (text) => {
        // 플러그인 markUserEdit: 이 노트와(워크플로 노트면) 실험 README 를 편집처럼 찍는다
        if (ctx.settings.autoUpdateLastUpdated) appUpkeep()?.markUserEdit(path);
        return stamp(text);
      };
    },
  };
}
