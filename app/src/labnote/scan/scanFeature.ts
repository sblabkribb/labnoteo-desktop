/**
 * 스캔 가져오기의 앱 쪽 한 덩어리(플러그인 BarcodeFeature 의 스캔 절반). 보관함마다 하나를 만들고(setScanFeature) 바꿀 때 dispose 한다.
 * - 페이지 해독기는 캔버스 해독기(pageDecoder.ts): pdf.js 는 첫 PDF 에서 불러오고, 해독 워커는 첫 페이지에서 띄운다.
 *   이미지 크기와 품질은 부를 때마다 지금 설정을 읽는다.
 * - 한 번에 한 묶음(port/scanFeatureRuns.ts). 사용자가 부른 실행(가져오기 창, 지금 처리)은 진행 창과 결과 창을 열고,
 *   배경 실행(폴더 감시, Slack)은 대화상자를 열지 않고 초점도 옮기지 않는다(B8).
 * - 미분류 대기열(openUnmatched, Task 26): 창에서 Assign 을 누르면 창을 닫고 노트 → 유닛 오퍼레이션 → 페이지 → 날짜를 물어 넣은 뒤
 *   창을 다시 연다(플러그인은 모달을 다시 그린다). 대화상자는 한 번에 하나만 보이므로 고르기 창은 대기열 창을 닫은 뒤에 연다.
 * - 스캔 폴더 감시(port/scanFolderWatcher.ts): `watcher`. 보관함을 열면 start(), 폴더나 방식을 바꾸면 restart(), 닫으면 dispose 가 stop().
 *   지금 처리(processFolderNow)는 사용자가 부른 실행이라 진행 창과 결과 창을 연다. 30초 폴링과 폴더 변경 이벤트는 배경 실행이다.
 * - Slack 받은 편지함(port/slackInbox.ts): `slack`. 보관함을 열면 start()(90초마다, 연결을 켠 보관함만), 닫으면 dispose 가 stop().
 *   Slack 으로 온 사진은 배경 실행이다(대화상자 없음, QR 없는 사진도 결과로 알린다).
 * - 보관함 바꾸기(SP6 D11): 묶음마다(가져오기는 시작할 때, 폴더 감시는 틱마다, Slack 은 확인마다) vaultGuard 를 잡아 파이프라인에
 *   넘긴다. 파이프라인은 쓰기 전마다 guard.check() 를 부르고, 보관함이 바뀌었으면 아무것도 더 쓰지 않고 끝난다(알림 없음).
 *   결과 알림의 Details 와 Show results 는 그 보관함이 닫히면 아무것도 열지 않는다. 알림 자체는 App 이 보관함을 바꿀 때 비운다.
 */
import { listVaultImages, readVaultImage } from '../../fs/vaultImage';
import { vaultGuard, type InvokeFn, type ListenFn, type VaultGuard } from '../../integrations/netIpc';
import { withProgress } from '../../integrations/progressStore';
import { appNoteIdSource } from '../barcode/noteIdSource';
import { noteIds } from '../barcode/noteIdIndex';
import type { CommandContext } from '../commands/context';
import { notify, notifyStatus } from '../host/toastStore';
import { coreT } from '../i18n';
import { NoteIdService } from '../port/noteIdService';
import { createPageDecoder } from '../port/pageDecoder';
import { ScanRuns } from '../port/scanFeatureRuns';
import { ScanFolderWatcher } from '../port/scanFolderWatcher';
import {
  ScanPipeline,
  isCancelled,
  unzipScans,
  type PageDecoder,
  type PipelineDeps,
  type ScanInput,
  type ScanResult,
} from '../port/scanPipeline';
import { summarizeResults } from '../port/scanResults';
import { SlackInbox } from '../port/slackInbox';
import { assignUnmatched, listUnmatched, type AssignDeps } from '../port/unmatchedScans';
import { createDecodeClient, type DecodeClient } from './decodeClient';
import { openImportDialog } from './ImportDialog';
import { pipelineDeps } from './pipelineDeps';
import { openResultsDialog } from './ResultsDialog';
import { openUnmatchedDialog, type UnmatchedIo } from './UnmatchedDialog';

export interface ScanFeatureDeps {
  pipeline: ScanPipeline;
  decoder: PageDecoder;
  withProgress: typeof withProgress;
  notifyStatus: typeof notifyStatus;
  notify: typeof notify;
  /** The vault's images for the unmatched queue (default: vault_list_images and vault_read_image). */
  images: { list(): Promise<string[]>; read(path: string): Promise<ArrayBuffer> };
  /** IPC for the scan folder watcher (default: Tauri's). */
  invoke: InvokeFn;
  listen: ListenFn;
  /** The decode client to use instead of a new one over the real worker; the feature terminates it on dispose. */
  decodeClient: DecodeClient;
  /** The vault guard each batch, folder tick and Slack check takes (default: vaultGuard over invoke). */
  guard: () => Promise<VaultGuard>;
}

export class ScanFeature {
  readonly pipeline: ScanPipeline;
  readonly decoder: PageDecoder;
  /** The scan folder watcher: the settings section calls restart() after choosing, clearing or changing the mode. */
  readonly watcher: ScanFolderWatcher;
  /** The Slack inbox: the settings section calls verify, beginLink and disconnect. */
  readonly slack: SlackInbox;
  private readonly runs: ScanRuns;
  private readonly notify: typeof notify;
  /** The decode worker this feature started (none when the decoder was handed in). */
  private readonly client?: DecodeClient;
  private readonly unmatchedIo: UnmatchedIo;
  private readonly assignDeps: AssignDeps;

  constructor(ctx: CommandContext, deps: Partial<ScanFeatureDeps> = {}) {
    if (deps.decoder) {
      this.decoder = deps.decoder;
    } else {
      const client = deps.decodeClient ?? createDecodeClient();
      this.client = client;
      this.decoder = createPageDecoder(
        () => ({ maxEdge: ctx.settings.scanMaxImageEdge, quality: ctx.settings.scanJpegQuality }),
        { pdf: () => import('./pdfjs').then((m) => m.loadPdfLib()), decode: client, unzip: unzipScans },
      );
    }
    const pd: PipelineDeps | undefined = deps.pipeline ? undefined : pipelineDeps(ctx, this.decoder);
    this.pipeline = deps.pipeline ?? new ScanPipeline(pd!);
    this.notify = deps.notify ?? notify;
    const guard = deps.guard ?? (() => vaultGuard(deps.invoke));
    this.runs = new ScanRuns({
      guard,
      pipeline: this.pipeline,
      withProgress: deps.withProgress ?? withProgress,
      notifyStatus: deps.notifyStatus ?? notifyStatus,
      notify: this.notify,
      read: (path) => ctx.host.fs.read(path),
      openFile: (path, at) => ctx.openFile(path, at),
      openResults: (results, actions) => void openResultsDialog(results, this.pipeline, actions),
      openUnmatched: () => void this.openUnmatched(),
    });
    this.watcher = new ScanFolderWatcher({
      run: (inputs, opts, manual) => this.runWithProgress(inputs, opts.skipNoQr, manual, opts.guard),
      report: (results, manual, g) => this.report(results, manual, g),
      guard,
      notify: (message) => this.notify('info', message),
      invoke: deps.invoke,
      listen: deps.listen,
    });
    this.slack = new SlackInbox({
      run: (inputs, g) => this.runWithProgress(inputs, false, false, g),
      summarize: (results) => summarizeResults(coreT, results),
      notify: (message) => this.notify('info', message),
      report: (results, g) => this.report(results, false, g),
      guard,
      invoke: deps.invoke,
    });
    const images = deps.images ?? { list: () => listVaultImages(), read: (path: string) => readVaultImage(path) };
    this.unmatchedIo = {
      list: async () => listUnmatched(await images.list()),
      read: (path) => images.read(path),
      trash: (path) => ctx.host.fs.trash(path),
    };
    // The pipeline's own NoteIdService when it made one; otherwise one over the same index, made on first use.
    let ids: NoteIdService | undefined;
    const pipeline = this.pipeline;
    this.assignDeps = {
      host: ctx.host,
      pipeline,
      noteIds: {
        filesWithId: (id) => (pd?.noteIds ?? (ids ??= new NoteIdService(appNoteIdSource(noteIds(), ctx.host.fs), ctx.host))).filesWithId(id),
      },
      notes: async () => {
        await noteIds().ready();
        return noteIds().refs();
      },
      read: (path) => ctx.host.fs.read(path),
    };
  }

  /** "Import scanned pages": the drop dialog, then one manual batch and its results. */
  async openImport(): Promise<void> {
    const inputs = await openImportDialog();
    if (!inputs?.length) return;
    try {
      const results = await this.runWithProgress(inputs, false, true);
      this.report(results, true);
    } catch (err) {
      if (isCancelled(err)) return; // the vault was switched mid-run: nothing more was written
      this.notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    }
  }

  /** "Process scan folder now" (and "Process existing files too" with `includeExisting`): one manual look at the folder. */
  async processFolderNow(includeExisting = false): Promise<void> {
    try {
      await this.watcher.tick({ manual: true, includeExisting });
    } catch (err) {
      if (isCancelled(err)) return;
      this.notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * "Assign unmatched scans": the queue dialog. Assign closes it, asks where the page goes and files it, then the
   * queue opens again (with what is left) until the user closes it.
   */
  async openUnmatched(): Promise<void> {
    for (;;) {
      const item = await openUnmatchedDialog(this.unmatchedIo);
      if (!item) return;
      try {
        await assignUnmatched(this.assignDeps, item);
      } catch (err) {
        this.notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    }
  }

  /** How many pages wait in the unmatched queue (the settings section's "Unmatched scans" row). */
  async unmatchedCount(): Promise<number> {
    return (await this.unmatchedIo.list()).length;
  }

  /** One batch at a time: a batch started while another runs waits for it. `guard`: the caller's vault guard. */
  runWithProgress(inputs: ScanInput[], skipNoQr: boolean, manual: boolean, guard?: VaultGuard): Promise<ScanResult[]> {
    return this.runs.runWithProgress(inputs, skipNoQr, manual, guard);
  }

  /** A manual run opens the results; a background run posts a toast whose Details opens them (not after a vault switch). */
  report(results: ScanResult[], manual: boolean, guard?: VaultGuard): void {
    this.runs.report(results, manual, guard);
  }

  /** Stops the folder watcher, the Slack inbox and the decode worker. */
  dispose(): void {
    this.watcher.stop();
    this.slack.stop();
    this.client?.terminate();
  }
}

let current: ScanFeature | undefined;

/** The open vault's scan feature (undefined before a vault opens). */
export function scanFeature(): ScanFeature | undefined {
  return current;
}

export function setScanFeature(f: ScanFeature | undefined): void {
  current = f;
}
