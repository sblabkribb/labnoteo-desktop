/**
 * 실험별 sample_tracking 캐시(계획 D11, Task 4). 실험 README.labnote.md 의 앞부분을 한 번 읽어 두고,
 * 표시용 on() 은 동기로, 쓰기용 ready() 는 README 를 기다린 뒤 답한다.
 * 읽지 못한 README 는 `{}`(켜짐)로 친다. invalidate 는 그 경로 아래의 캐시를 버리고 바뀐 것이 있으면 onChange 를 부른다.
 */
import type { LabnoteFs } from '@labnoteo/core';
import { parseFrontMatterYaml } from '@labnoteo/core';
import { getExperimentDir, isSampleTrackingOn } from '@labnoteo/core/lib/labnoteStructure';
import { frontMatterText } from '../labnote/frontMatterText';

type FrontMatter = Record<string, unknown>;

const README_NAME = 'README.labnote.md';
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export class SampleTracking {
  private readonly cache = new Map<string, FrontMatter | Promise<FrontMatter>>();

  constructor(
    private readonly fs: LabnoteFs,
    private readonly onChange: () => void,
  ) {}

  /** Synchronous, for display; before the README is read it answers from `enabled` alone and starts the read. */
  on(enabled: boolean, path: string | undefined): boolean {
    return isSampleTrackingOn(enabled, path, (readme) => {
      const hit = this.load(readme);
      return hit instanceof Promise ? undefined : hit;
    });
  }

  /** For writes: awaits the README read, then answers. */
  async ready(enabled: boolean, path: string | undefined): Promise<boolean> {
    if (!enabled) return false;
    const dir = path ? getExperimentDir(path) : undefined;
    let fm: FrontMatter | undefined;
    if (dir) fm = await this.load(`${dir}/${README_NAME}`);
    return isSampleTrackingOn(enabled, path, () => fm);
  }

  /** Drops cached READMEs under these paths ('all' = everything) and calls onChange if any was dropped. */
  invalidate(paths: readonly string[] | 'all'): void {
    let dropped = false;
    if (paths === 'all') {
      dropped = this.cache.size > 0;
      this.cache.clear();
    } else {
      const ps = paths.map(norm);
      for (const dir of [...this.cache.keys()]) {
        const readme = `${dir}/${README_NAME}`;
        if (ps.some((p) => p === '' || readme === p || readme.startsWith(`${p}/`))) {
          this.cache.delete(dir);
          dropped = true;
        }
      }
    }
    if (dropped) this.onChange();
  }

  /** The cached front matter of an experiment README, or the pending read (started here on a miss). */
  private load(readmePath: string): FrontMatter | Promise<FrontMatter> {
    const dir = norm(readmePath).slice(0, -(README_NAME.length + 1));
    const hit = this.cache.get(dir);
    if (hit) return hit;
    const pending: Promise<FrontMatter> = this.fs
      .read(`${dir}/${README_NAME}`)
      .then((raw) => {
        const fm = parseFrontMatterYaml(frontMatterText(raw)).frontMatter;
        return fm && typeof fm === 'object' ? fm : {};
      })
      .catch(() => ({}))
      .then((fm) => {
        // 읽는 사이 invalidate 로 버려졌다면 옛 답을 다시 넣지 않는다.
        if (this.cache.get(dir) === pending) this.cache.set(dir, fm);
        return fm;
      });
    this.cache.set(dir, pending);
    return pending;
  }
}
