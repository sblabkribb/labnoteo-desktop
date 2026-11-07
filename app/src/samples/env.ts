import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { planReferenceInsert, type Translator } from '@labnoteo/core';
import { isSampleTrackingOn } from '@labnoteo/core/lib/labnoteStructure';
import { escapeSamplePipes } from '@labnoteo/core/lib/sampleUtils';
import { activeCellView } from '../editor/table/cellEditor';
import type { AppFs } from '../fs/tauriLabnoteFs';
import { linkIndex } from '../links/linkIndex';
import type { CommandContext } from '../labnote/commands/context';
import { toDocBreaks, type AppEditTarget } from '../labnote/editTarget';
import type { AppHost } from '../labnote/host/createAppHost';
import { activeEditTarget, processNote } from '../labnote/openNotes';
import { hasLocalScope, localSampleFolder } from '../labnote/port/sampleFolders';
import type { AppSettings } from '../labnote/settings';
import { sampleTypesFor } from './types';

/** 플러그인 settings.ts 의 globalSampleFolder 기본값. */
export const DEFAULT_GLOBAL_SAMPLE_FOLDER = 'resources/labsamples';

/**
 * 옮겨 온 샘플 흐름이 Obsidian 의 App 과 LabnotePlugin 대신 받는 것(D5). 명령 하나가 `createSampleEnv(ctx)` 로 만든다.
 */
export interface SampleEnv {
  readonly host: AppHost;
  /** safeRegistryFs(trashingFs(host.fs), globalFolder) (D13). */
  readonly fs: AppFs;
  readonly t: Translator;
  settings(): AppSettings;
  /** sampleTypesFor(settings()): every stored custom name, unfiltered (Task 2). */
  types(): string[];
  /** settings().globalSampleFolder trimmed and normalised; never passed through core getGlobalLabsamplesFolder. */
  globalFolder(): string;
  /** Port of main.ts:3265-3285 (core resolveLocalSampleFolder; remembers the last experiment only for non-note files). */
  localFolder(): string;
  /** Port of main.ts:3288-3290: activePath() !== undefined || lastExperimentDir !== undefined. */
  hasLocalScope(): boolean;
  trackingFor(path: string | undefined): boolean;
  /** All vault .md paths (linkIndex.files() after whenReady()). */
  markdownFiles(): Promise<string[]>;
  activePath(): string | undefined;
  editTarget(): AppEditTarget | undefined;
  /** D20: into the active cell editor when one is active, else at the outer cursor. false when no note is open. */
  insertAtCursor(text: string): boolean;
  processNote(path: string, transform: (text: string) => string): Promise<boolean>;
  openFile(path: string, at?: { line: number; ch?: number }): Promise<void>;
  /** Registry files or folders were written: the index re-reads them, the completion cache clears, the panel refreshes. */
  changed(paths?: readonly string[]): void;
}

/** 샘플 대장 JSON 의 지금 글이 비어 있지 않은데 JSON 객체로 읽히지 않는다(충돌 표시, 문법 오류). 아무것도 쓰지 않았다. */
export class RegistryUnreadableError extends Error {
  constructor(readonly path: string) {
    super(`sample registry cannot be read: ${path}`);
    this.name = 'RegistryUnreadableError';
  }
}

const slashes = (p: string) => p.replace(/\\/g, '/');

/** 설정의 Global 폴더: 앞뒤 공백을 떼고 `\` 를 `/` 로, 앞뒤 `/` 를 뗀다. 비면 기본 폴더. */
export function normalizeSampleFolder(folder: string | undefined): string {
  const f = slashes((folder ?? '').trim()).replace(/^\/+|\/+$/g, '');
  return f || DEFAULT_GLOBAL_SAMPLE_FOLDER;
}

/** '<…>/labsamples/<name>.json' (any depth, case-insensitive folder name) or '<globalFolder>/<name>.json'. */
export function isRegistryPath(path: string, globalFolder: string): boolean {
  const p = slashes(path);
  if (/(?:^|\/)labsamples\/[^/]+\.json$/i.test(p)) return true;
  const slash = p.lastIndexOf('/');
  if (slash < 0 || !/\.json$/i.test(p)) return false;
  const g = slashes(globalFolder).replace(/^\/+|\/+$/g, '');
  return g !== '' && p.slice(0, slash).toLowerCase() === g.toLowerCase();
}

/** 코어가 `{}` 로 읽어 버리지 않고 기록 객체로 읽을 수 있는 글인가(코어처럼 JSON.parse 그대로: BOM 도 못 읽는다). */
function isJsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** `remove(p)` 는 휴지통으로(`fs.trash`). 나머지는 그대로 넘긴다. 코어의 정리 삭제가 영구 삭제가 되지 않게(D13). */
export function trashingFs(fs: AppFs): AppFs {
  return {
    read: (p) => fs.read(p),
    write: (p, c) => fs.write(p, c),
    modify: (p, u) => fs.modify(p, u),
    exists: (p) => fs.exists(p),
    mkdir: (p) => fs.mkdir(p),
    list: (d) => fs.list(d),
    remove: (p) => fs.trash(p),
    rmdir: (p) => fs.rmdir(p),
    rename: (a, b) => fs.rename(a, b),
    trash: (p) => fs.trash(p),
  };
}

/**
 * modify/write of a registry JSON throw RegistryUnreadableError and write nothing when its current text is non-empty
 * and not a JSON object. 코어의 로더는 읽지 못한 대장을 `{}` 로 보므로, 그대로 두면 읽고-고치고-쓰기가 충돌한 파일을
 * 새 기록만으로 덮는다. modify 는 갱신 함수 안에서(원자적으로) 지금 글을 보고, write 는 먼저 읽어 본다.
 * 비었거나 없는 파일은 괜찮다. write 의 확인은 읽기와 쓰기 사이의 바깥 편집을 다시 보지 못한다(D13 이 받아들인 틈):
 * 대장을 쓰는 쪽은 되도록 modify 를 쓰고, write 의 확인은 겹 방어로 둔다.
 */
export function safeRegistryFs(fs: AppFs, globalFolder: () => string): AppFs {
  const unreadable = (p: string, current: string) => isRegistryPath(p, globalFolder()) && current.trim() !== '' && !isJsonObject(current);
  return {
    read: (p) => fs.read(p),
    exists: (p) => fs.exists(p),
    mkdir: (p) => fs.mkdir(p),
    list: (d) => fs.list(d),
    remove: (p) => fs.remove(p),
    rmdir: (p) => fs.rmdir(p),
    rename: (a, b) => fs.rename(a, b),
    trash: (p) => fs.trash(p),
    modify: (p, fn) =>
      fs.modify(p, (cur) => {
        if (unreadable(p, cur)) throw new RegistryUnreadableError(p);
        return fn(cur);
      }),
    async write(p, content) {
      if (isRegistryPath(p, globalFolder()) && (await fs.exists(p)) && unreadable(p, await fs.read(p))) {
        throw new RegistryUnreadableError(p);
      }
      return fs.write(p, content);
    },
  };
}

type PathsListener = (paths?: readonly string[]) => void;
const listeners = new Set<PathsListener>();

/** 명령이나 동기화가 샘플 대장을 썼다는 알림(D5 `env.changed`). 색인과 완성 캐시와 패널이 듣는다. */
export const sampleEvents = {
  emit(paths?: readonly string[]): void {
    for (const l of [...listeners]) {
      try {
        l(paths);
      } catch (e) {
        console.error('[sampleEvents] listener failed', e);
      }
    }
  },
  subscribe(fn: PathsListener): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** 명령 맥락으로 SampleEnv 를 만든다. 설정과 열린 노트는 부를 때마다 지금 값을 읽는다. */
export function createSampleEnv(ctx: CommandContext): SampleEnv {
  const globalFolder = () => normalizeSampleFolder(ctx.settings.globalSampleFolder);
  const fs = safeRegistryFs(trashingFs(ctx.host.fs), globalFolder);
  const types = () => sampleTypesFor(ctx.settings);

  return {
    host: ctx.host,
    fs,
    t: ctx.host.t,
    settings: () => ctx.settings,
    types,
    globalFolder,
    localFolder: () => localSampleFolder(ctx.activePath(), globalFolder()),
    hasLocalScope: () => hasLocalScope(ctx.activePath()),
    // README 의 sample_tracking 캐시(Task 4)와 저장소(Task 7)가 들어오기 전까지는 설정만으로 판단한다(D11 의 표시용 답).
    // TODO(Task 7): samples.trackingFor 에 맡긴다. README 에 `sample_tracking: no` 인 실험(062_Gel)이 지금은 켜짐으로 나온다.
    trackingFor: (path) => isSampleTrackingOn(ctx.settings.sampleTracking, path, () => undefined),
    async markdownFiles() {
      await linkIndex.whenReady();
      return linkIndex.files().filter((p) => p.endsWith('.md'));
    },
    activePath: () => ctx.activePath(),
    editTarget: () => activeEditTarget(ctx.activePath()),
    insertAtCursor(text) {
      const outer = ctx.activeView();
      if (!outer) return false;
      const cell = activeCellView(outer);
      if (cell) {
        // 표 칸에는 그 칸만 든 셀 편집기가 따로 있다: 그것에 쓴다(insertDate 와 같다, editorInserts.ts)
        cell.dispatch(cell.state.replaceSelection(escapeSamplePipes(text)), {
          annotations: Transaction.userEvent.of('input.labnote'),
        });
        // 다음 입력이 이 참조에 합쳐지지 않게 바깥 기록을 끊는다
        outer.dispatch({ annotations: isolateHistory.of('after') });
        return true;
      }
      const state = outer.state;
      const { from, to } = state.selection.main;
      const plan = planReferenceInsert(state.doc.toString(), from, text, types(), to > from ? to : undefined);
      const insert = toDocBreaks(plan.text, state);
      const end = plan.end ?? plan.offset;
      // 커서는 바뀐 범위 끝을 옮겨 잡는다. insert.length 는 안 된다: CRLF 줄 구분자 노트에서 줄바꿈은 두 글자지만 한 칸이다.
      const changes = state.changes({ from: plan.offset, to: end, insert });
      outer.dispatch({
        changes,
        selection: { anchor: changes.mapPos(end, 1) },
        scrollIntoView: true,
        annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.labnote')],
      });
      return true;
    },
    processNote: (path, transform) => processNote(ctx.host.fs, path, transform),
    openFile: (path, at) => ctx.openFile(path, at),
    changed: (paths) => sampleEvents.emit(paths),
  };
}
