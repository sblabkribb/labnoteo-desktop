/**
 * Workflows 패널의 실험 목록: 플러그인 workflowView.ts 의 experiments()(211-280)와 checklistProgress(290-327)를
 * Obsidian 의 메타데이터 캐시 대신 LabnoteFs 위에서 한다. 첫 그리기는 README 와 폴더 목록만 읽는다.
 * `@issue` 마커는 실험의 노트 본문을 모두 읽어야 하므로 뒤에서 따로 센다(countMarkers, 동시에 실험 4개까지).
 */
import type { ExperimentEntry, LabnoteFs } from '@labnoteo/core';
import { frontMatterNames, isDiscussFlagged, linkRetries, parseFrontMatterYaml } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { retryOfLinkpath } from '@labnoteo/core/lib/labnoteStructure';
import { parseWorkflowChecklistFromReadme } from '@labnoteo/core/lib/workflowStructure';
import { experimentMarkerSpots } from '../../../vendor/labnoteo/src/issueMarkerIndex';
import { README } from '../paths';
import { checklistProgress } from '../port/workflowView';

const NOTE = /\.labnote\.md$/i;
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

/** 폴더 목록 `names` 를 이미 읽은 실험 폴더의 항목. */
async function entryFrom(fs: LabnoteFs, folder: string, names: readonly string[], markers?: number): Promise<ExperimentEntry> {
  let text = '';
  try {
    text = await fs.read(posix.join(folder, README));
  } catch {
    // 읽지 못한 README: 폴더 이름만으로 보인다
  }
  // Windows 에서 만든 README: BOM 과 CRLF 를 걷어 낸 뒤 읽는다
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const parsed = parseFrontMatterYaml(text);
  const fm: Record<string, unknown> = parsed.frontMatter ?? {};
  const updated = fm.last_updated_date;

  // 체크리스트 항목의 노트가 있는가: 폴더 목록에서, 없으면 그 링크 경로(보관함 기준)에서 본다
  const present = new Set(names.map((n) => fold(posix.join(folder, n))));
  const items = parseWorkflowChecklistFromReadme(text);
  for (const item of items) {
    const link = item.fileName;
    if (!link || present.has(fold(posix.join(folder, link)))) continue;
    try {
      if (await fs.exists(posix.normalize(link))) present.add(fold(link));
    } catch {
      // 잘못된 경로: 없는 노트로 센다
    }
  }

  const linkpath = retryOfLinkpath(fm.retry_of);
  const retryOf = linkpath ? posix.dirname(linkpath) : undefined;
  return {
    folder,
    title: typeof fm.title === 'string' ? fm.title : undefined,
    status: typeof fm.status === 'string' ? fm.status : undefined,
    discuss: isDiscussFlagged(fm),
    lastUpdated: typeof updated === 'string' && updated.trim() ? updated.trim() : undefined,
    progress: checklistProgress(folder, items, (p) => present.has(fold(p))),
    project: typeof fm.project === 'string' || typeof fm.project === 'number' ? String(fm.project) : undefined,
    authors: frontMatterNames(fm.author),
    workflowNames: names.filter((n) => NOTE.test(n) && n !== README).map((n) => n.replace(NOTE, '').replace(/_/g, ' ')),
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
export async function readExperimentEntry(fs: LabnoteFs, folder: string, markers?: number): Promise<ExperimentEntry> {
  return entryFrom(fs, folder, await listNames(fs, folder), markers);
}

/**
 * 패널이 다시 그릴 때마다 모든 README 를 다시 읽지 않게 실험 항목을 기억한다. 바뀐 경로가 들어오면 그 경로를 품은
 * 실험만 버린다(invalidate). 폴더 목록(labnote/)은 all() 마다 다시 읽어 새 실험과 사라진 실험을 본다.
 */
export class ExperimentEntryCache {
  /** 폴더(소문자) -> 항목. null 은 README 가 없는 번호 폴더(실험이 아니다). */
  private readonly entries = new Map<string, ExperimentEntry | null>();
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
  async all(): Promise<ExperimentEntry[]> {
    const names = (await listNames(this.fs, 'labnote')).filter((n) => EXPERIMENT.test(n));
    const folders = [...new Map(names.map((n) => [fold(n), posix.join('labnote', n)])).values()];
    const read = await Promise.all(
      folders.map(async (folder) => {
        const key = fold(folder);
        const cached = this.entries.get(key);
        if (cached !== undefined) return cached;
        const before = this.version(key);
        const kids = await listNames(this.fs, folder);
        const entry = kids.some((k) => fold(k) === fold(README)) ? await entryFrom(this.fs, folder, kids) : null;
        if (this.version(key) === before) this.entries.set(key, entry);
        return entry;
      }),
    );
    this.folders = folders.filter((_, i) => read[i] !== null);
    const out = read
      .filter((e): e is ExperimentEntry => e !== null)
      .map((e) => ({ ...e, markers: this.markers.get(fold(e.folder)) ?? 0 }));
    return linkRetries(out);
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
