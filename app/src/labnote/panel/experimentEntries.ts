/**
 * Workflows 패널의 실험 목록: 플러그인 workflowView.ts 의 experiments()(211-280)와 checklistProgress(290-327)를
 * Obsidian 의 메타데이터 캐시 대신 LabnoteFs 위에서 한다. 첫 그리기는 README 와 폴더 목록만 읽는다.
 * `@issue` 마커는 실험의 노트 본문을 모두 읽어야 하므로 뒤에서 따로 센다(countMarkers, 동시에 실험 4개까지).
 */
import type { ExperimentEntry, LabnoteFs } from '@labnoteo/core';
import { frontMatterNames, isDiscussFlagged, linkRetries, parseFrontMatterYaml } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { retryOfLinkpath } from '@labnoteo/core/lib/labnoteStructure';
import { experimentMarkerSpots } from '../../../vendor/labnoteo/src/issueMarkerIndex';
import { frontMatterText } from '../frontMatterText';
import { checklistEntries, checklistTickOf } from '../checklistTick';
import { isReadmeName, README, readmeNameIn } from '../paths';
import { checklistProgress } from '../port/workflowView';

const NOTE = /\.labnote\.md$/i;
/** 예전(VS Code 시절) Workflow 노트의 이름: `NNN_Wxxx_*.md`(paths.ts 의 isWorkflowNote 와 같은 규칙). */
const LEGACY_NOTE = /^\d{3}_[A-Z]{2}\d{3}_.+\.md$/;
/** 실험 폴더 바로 안의 Workflow 노트 이름인가: `.labnote.md`(README 빼고), 또는 예전 이름. */
const isWorkflowName = (n: string) => !isReadmeName(n) && (NOTE.test(n) || LEGACY_NOTE.test(n));
/** 실험 폴더 안의 그림 폴더와 첨부 폴더(실험 탭이 개수와 함께 보인다). */
const IMAGES = 'images';
const RESOURCES = 'resources';
/** resources/ 안의 시스템 폴더: 첨부로 세지 않는다. */
const SYSTEM_IN_RESOURCES = new Set(['labsamples', 'workflows']);
const EXPERIMENT = /^\d{3}_/;
/** 마커를 동시에 세는 실험의 수. */
const MARKER_CONCURRENCY = 4;

const fold = (p: string) => p.toLowerCase();

async function listNames(fs: LabnoteFs, dir: string): Promise<string[]> {
  try {
    return await fs.list(dir);
  } catch {
    return [];
  }
}

/** 실험 폴더의 워크플로 노트 하나: README 체크리스트에서 체크했는가. */
export interface WorkflowFile {
  /** 보관함 경로. */
  path: string;
  fileName: string;
  /** README "Related Workflows" 체크리스트에서 이 노트의 항목이 [x] 다. */
  ticked: boolean;
}

/**
 * 실험 탭의 항목: 코어의 ExperimentEntry 에 앱이 더 읽은 것. 워크플로 노트(파일 이름 차례), 그림과 첨부의 개수
 * (폴더가 있을 때만), README 경로.
 */
export interface PanelEntry extends ExperimentEntry {
  readme: string;
  workflowFiles: WorkflowFile[];
  images?: number;
  resources?: number;
}

/** 하위 폴더의 항목 수(폴더가 없으면 undefined). `skip` 의 이름(소문자)은 세지 않는다. */
async function countIn(fs: LabnoteFs, folder: string, names: readonly string[], sub: string, skip?: ReadonlySet<string>): Promise<number | undefined> {
  const name = names.find((n) => fold(n) === sub);
  if (name === undefined) return undefined;
  const kids = await listNames(fs, posix.join(folder, name));
  return kids.filter((k) => !k.startsWith('.') && !skip?.has(fold(k))).length;
}

/** 폴더 목록 `names` 를 이미 읽은 실험 폴더의 항목. */
async function entryFrom(fs: LabnoteFs, folder: string, names: readonly string[], markers?: number): Promise<PanelEntry> {
  // 실험마다 README 를 고른다: README.labnote.md, 없으면 예전 보관함의 README.md
  const readme = posix.join(folder, readmeNameIn(names) ?? README);
  let text = '';
  try {
    text = await fs.read(readme);
  } catch {
    // 읽지 못한 README: 폴더 이름만으로 보인다
  }
  // Windows 에서 만든 README: BOM 과 CRLF 를 걷어 낸 뒤 읽는다
  text = frontMatterText(text);
  const parsed = parseFrontMatterYaml(text);
  const fm: Record<string, unknown> = parsed.frontMatter ?? {};
  const updated = fm.last_updated_date;
  const created = fm.created_date;

  // 체크리스트 항목의 노트가 있는가: 폴더 목록에서, 없으면 그 링크 경로(보관함 기준)에서 본다
  const present = new Set(names.map((n) => fold(posix.join(folder, n))));
  // 예전 보관함의 줄(`.md` 링크)도 센다(checklistTick.ts)
  const items = checklistEntries(text).map((e) => ({ done: e.done, fileName: e.link }));
  for (const item of items) {
    const link = item.fileName;
    if (!link || present.has(fold(posix.join(folder, link)))) continue;
    try {
      if (await fs.exists(posix.normalize(link))) present.add(fold(link));
    } catch {
      // 잘못된 경로: 없는 노트로 센다
    }
  }

  // 워크플로 노트: 파일 이름(번호) 차례. 예전 이름(`NNN_Wxxx_*.md`)도 든다. 체크 여부는 체크리스트에서 그 노트의 줄을 본다
  // (파일 이름 대소문자 무시, 예전 꼴의 `.md` 링크도: checklistTick.ts)
  const workflowFiles = names
    .filter(isWorkflowName)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((fileName) => ({ path: posix.join(folder, fileName), fileName, ticked: checklistTickOf(text, fileName) === true }));
  const [images, resources] = await Promise.all([
    countIn(fs, folder, names, IMAGES),
    countIn(fs, folder, names, RESOURCES, SYSTEM_IN_RESOURCES),
  ]);

  const linkpath = retryOfLinkpath(fm.retry_of);
  const retryOf = linkpath ? posix.dirname(linkpath) : undefined;
  return {
    folder,
    readme,
    workflowFiles,
    ...(images !== undefined ? { images } : {}),
    ...(resources !== undefined ? { resources } : {}),
    title: typeof fm.title === 'string' ? fm.title : undefined,
    status: typeof fm.status === 'string' ? fm.status : undefined,
    discuss: isDiscussFlagged(fm),
    lastUpdated: typeof updated === 'string' && updated.trim() ? updated.trim() : undefined,
    created: typeof created === 'string' && created.trim() ? created.trim() : undefined,
    progress: checklistProgress(folder, items, (p) => present.has(fold(p)), fold),
    project: typeof fm.project === 'string' || typeof fm.project === 'number' ? String(fm.project) : undefined,
    authors: frontMatterNames(fm.author),
    workflowNames: names.filter(isWorkflowName).map((n) => n.replace(/(\.labnote)?\.md$/i, '').replace(/_/g, ' ')),
    markers: markers ?? 0,
    ...(retryOf && fold(retryOf) !== fold(folder) ? { retryOf } : {}),
    ...(parsed.parseError ? { frontMatterError: parsed.parseError } : {}),
  };
}

/**
 * 실험 폴더 하나의 항목: README 의 title, status, discuss, last_updated_date, project, author, 체크리스트 진행
 * (노트가 있는 항목만, 두 번 적힌 노트는 첫 항목으로 한 번), 폴더의 워크플로 노트 이름(찾기용), retry_of 가 가리키는 폴더.
 * `markers` 는 준 값, 없으면 0 이다(마커는 countMarkers 가 따로 센다).
 */
export async function readExperimentEntry(fs: LabnoteFs, folder: string, markers?: number): Promise<PanelEntry> {
  return entryFrom(fs, folder, await listNames(fs, folder), markers);
}

/**
 * 패널이 다시 그릴 때마다 모든 README 를 다시 읽지 않게 실험 항목을 기억한다. 바뀐 경로가 들어오면 그 경로를 품은
 * 실험만 버린다(invalidate). 폴더 목록(labnote/)은 all() 마다 다시 읽어 새 실험과 사라진 실험을 본다.
 */
export class ExperimentEntryCache {
  /** 폴더(소문자) -> 항목. null 은 README 가 없는 번호 폴더(실험이 아니다). */
  private readonly entries = new Map<string, PanelEntry | null>();
  /** 폴더(소문자) -> 센 마커 수. */
  private readonly markers = new Map<string, number>();
  /** 폴더(소문자) -> 버린 횟수(+ epoch). 읽는 사이 버려졌으면 읽은 값을 기억하지 않는다. */
  private readonly versions = new Map<string, number>();
  /** invalidate('all') 횟수: 아직 기억하지 않은 폴더를 읽는 중이었어도 그 값을 버리게 한다. */
  private epoch = 0;
  /** 마지막 all() 이 본 실험 폴더(디스크 철자). */
  private folders: string[] = [];

  constructor(private readonly fs: LabnoteFs) {}

  private version(key: string): string {
    return `${this.epoch}:${this.versions.get(key) ?? 0}`;
  }

  private drop(key: string): void {
    this.entries.delete(key);
    this.markers.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  /** labnote/ 바로 아래 ###_ 폴더 가운데 README 가 있는 것들의 항목(재실험 연결 포함). 노트 본문은 읽지 않는다. */
  async all(): Promise<PanelEntry[]> {
    const names = (await listNames(this.fs, 'labnote')).filter((n) => EXPERIMENT.test(n));
    const folders = [...new Map(names.map((n) => [fold(n), posix.join('labnote', n)])).values()];
    const read = await Promise.all(
      folders.map(async (folder) => {
        const key = fold(folder);
        const cached = this.entries.get(key);
        if (cached !== undefined) return cached;
        const before = this.version(key);
        const kids = await listNames(this.fs, folder);
        // README.labnote.md 또는 예전 README.md 가 있는 번호 폴더가 실험이다
        const entry = readmeNameIn(kids) !== undefined ? await entryFrom(this.fs, folder, kids) : null;
        if (this.version(key) === before) this.entries.set(key, entry);
        return entry;
      }),
    );
    this.folders = folders.filter((_, i) => read[i] !== null);
    const out = read
      .filter((e): e is PanelEntry => e !== null)
      .map((e) => ({ ...e, markers: this.markers.get(fold(e.folder)) ?? 0 }));
    // linkRetries 는 항목을 펼쳐 복사하므로 앱의 칸(workflowFiles 등)이 남는다
    return linkRetries(out) as PanelEntry[];
  }

  /**
   * 아직 세지 않은 실험의 `@issue` 마커를 뒤에서 센다. 동시에 실험 4개까지, 하나를 셀 때마다 `onCount` 를 부른다.
   * 돌려준 함수를 부르면 멈춘다(더 부르지 않는다).
   */
  countMarkers(onCount: (folder: string, n: number) => void): () => void {
    let cancelled = false;
    const queue = this.folders.filter((f) => !this.markers.has(fold(f)));
    const worker = async () => {
      for (let folder = queue.shift(); folder !== undefined && !cancelled; folder = queue.shift()) {
        const key = fold(folder);
        const before = this.version(key);
        let n: number;
        try {
          n = (await experimentMarkerSpots(this.fs, folder)).length;
        } catch {
          continue;
        }
        if (cancelled || this.version(key) !== before) continue;
        this.markers.set(key, n);
        onCount(folder, n);
      }
    };
    for (let i = 0; i < Math.min(MARKER_CONCURRENCY, queue.length); i++) void worker();
    return () => {
      cancelled = true;
    };
  }

  /** 바뀐 경로를 품은 실험의 항목과 마커 수를 버린다. 'all' 이면 모두 버린다. */
  invalidate(paths: readonly string[] | 'all'): void {
    if (paths === 'all') {
      this.epoch++;
      this.entries.clear();
      this.markers.clear();
      return;
    }
    const changed = paths.map(fold);
    for (const key of new Set([...this.entries.keys(), ...this.markers.keys()])) {
      if (changed.some((p) => p === key || p.startsWith(`${key}/`))) this.drop(key);
    }
  }
}
