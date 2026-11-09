/**
 * 스캔 명령 셋과 보관함마다의 스캔 배선(SP7 Part B).
 * - 명령: 플러그인 barcodeFeature 의 addCommand 셋(같은 id, 같은 이름, 같은 순서). 모두 열린 보관함의 ScanFeature 로 간다.
 *   "지금 스캔 폴더 처리"는 이 보관함에 스캔 폴더가 있을 때만 팔레트에 보인다: Rust 가 마지막으로 알려 준 scanFolderStatus().path.
 *   그 값은 보관함을 열 때 읽고, 감시자가 상태를 다시 읽을 때마다(설정에서 폴더를 고르거나 지우거나 방식을 바꾸면 restart) 따라간다.
 * - startScan: 보관함을 열면 ScanFeature 를 놓고, Rust 의 폴더 감시를 켜고, 폴더 감시자(30초 폴링), Slack 받은 편지함
 *   (90초, 연결을 켠 보관함만), 노트를 따라가는 스캔 옮기기를 시작한다. 돌려준 함수는 그 모두를 거두고 해독 워커를 끝낸다.
 *   App.tsx 는 보관함을 바꿀 때 이것을 cancelAllRequests 보다 먼저 부른다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { vaultImages } from '../../editor/live/vaultImages';
import type { InvokeFn } from '../../integrations/netIpc';
import { notifyingRun } from '../barcode/idWatch';
import type { CommandContext } from '../commands/context';
import type { Command } from '../commands/registry';
import { processNote } from '../openNotes';
import { startScanMoves } from '../port/scanMoves';
import { ScanFeature, scanFeature, setScanFeature, type ScanFeatureDeps } from './scanFeature';
import { scanFolderStatus, scanFolderWatch, type ScanFolderStatus } from './scanIpc';

/** The open vault's scan folder as Rust last reported it; null when there is none (or no vault is open). */
let folderPath: string | null = null;
/** Bumped by each start and stop: a status reply for an earlier vault sets nothing. */
let generation = 0;

/** Whether the open vault has a scan folder (the last status Rust gave). */
export function hasScanFolder(): boolean {
  return folderPath !== null;
}

/** An invoke that notes every scan folder status it carries back, for {@link hasScanFolder}. */
function observingStatus(invoke: InvokeFn, gen: number): InvokeFn {
  return (async (cmd: string, args?: Record<string, unknown>) => {
    const reply = await invoke(cmd, args);
    if (cmd === 'scan_folder_status' && gen === generation) folderPath = (reply as ScanFolderStatus | null)?.path ?? null;
    return reply;
  }) as InvokeFn;
}

export const scanCommands: Command[] = [
  {
    id: 'import-scanned-pages',
    nameKey: 'Import scanned pages',
    run: async () => {
      await scanFeature()?.openImport();
    },
  },
  {
    id: 'process-scan-folder',
    nameKey: 'Process scan folder now',
    available: () => hasScanFolder(),
    run: async () => {
      await scanFeature()?.processFolderNow();
    },
  },
  {
    id: 'assign-unmatched-scans',
    nameKey: 'Assign unmatched scans',
    run: async () => {
      await scanFeature()?.openUnmatched();
    },
  },
];

/**
 * Starts the vault's scan import: the feature, Rust's folder watch, the folder watcher, the Slack inbox and scan moves.
 * The returned function stops all of them and terminates the decode worker.
 */
export function startScan(ctx: CommandContext, deps: Partial<ScanFeatureDeps> = {}): () => void {
  const gen = ++generation;
  folderPath = null;
  const invoke = observingStatus(deps.invoke ?? tauriInvoke, gen);
  const feature = new ScanFeature(ctx, { ...deps, invoke });
  setScanFeature(feature);
  void scanFolderWatch(invoke).catch((err: unknown) =>
    console.warn('[labnoteo] could not watch the scan folder', err instanceof Error ? err.name : typeof err),
  );
  feature.watcher.start();
  feature.slack.start();
  const stopMoves = startScanMoves({
    fs: ctx.host.fs,
    host: ctx.host,
    processNote: (path, fn) => processNote(ctx.host.fs, path, fn),
    run: notifyingRun(ctx.host),
    imagesMoved: () => vaultImages.index.invalidate(),
  });
  return () => {
    stopMoves();
    feature.dispose();
    if (scanFeature() === feature) setScanFeature(undefined);
    if (gen === generation) {
      generation++;
      folderPath = null;
    }
  };
}
