/**
 * 뒤로·앞으로 가기 기록(SP4 Task 28, D4). Obsidian 처럼 노트를 열 때마다 떠나는 자리(노트와 커서 줄)를 쌓고,
 * Alt+←/→ 와 마우스의 뒤로·앞으로 단추가 그 자리로 돌아간다. 순수한 자료 구조다: 여는 일은 App 이 한다.
 */
import { linkKey } from './resolve';
import type { Move } from './rewrite';

export const NAV_MAX = 100;

export interface NavEntry {
  path: string;
  /** 0부터 센 커서 줄. */
  line: number;
}

/** path 가 지워진 dir 이거나 그 안에 있다(지운 경로 그대로 비교한다: 대소문자만 바꾼 이름 바꾸기 뒤의 감시 알림이 새 항목을 지우지 않게). */
function isAtOrUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

export class NavHistory {
  private backStack: NavEntry[] = [];
  private forwardStack: NavEntry[] = [];

  /** 노트를 떠나기 전에 부른다. 앞으로 가기 기록을 비우고, NAV_MAX 를 넘으면 가장 오래된 것을 버린다. */
  push(from: NavEntry): void {
    this.backStack.push({ ...from });
    if (this.backStack.length > NAV_MAX) this.backStack.splice(0, this.backStack.length - NAV_MAX);
    this.forwardStack = [];
  }

  /**
   * 지금 자리(current)를 앞으로 가기 기록에 두고 돌아갈 자리를 돌려준다. 없으면 undefined(아무것도 바꾸지 않는다).
   * 열린 노트가 없으면(지웠거나 닫았다) current 없이 부른다: 그때는 돌아올 자리를 남기지 않는다.
   */
  back(current?: NavEntry): NavEntry | undefined {
    const to = this.backStack.pop();
    if (!to) return undefined;
    if (current) this.forwardStack.push({ ...current });
    return to;
  }

  /** back 의 반대. */
  forward(current?: NavEntry): NavEntry | undefined {
    const to = this.forwardStack.pop();
    if (!to) return undefined;
    if (current) this.backStack.push({ ...current });
    if (this.backStack.length > NAV_MAX) this.backStack.splice(0, this.backStack.length - NAV_MAX);
    return to;
  }

  /** 지워진 노트나 폴더: 그 경로이거나 그 안에 있는 항목을 두 기록 모두에서 뺀다. */
  drop(path: string): void {
    this.backStack = this.backStack.filter((e) => !isAtOrUnder(e.path, path));
    this.forwardStack = this.forwardStack.filter((e) => !isAtOrUnder(e.path, path));
  }

  /** 이름 바꾸기: 옮겨진 파일의 항목을 새 경로로 바꾼다(폴더는 파일마다 한 쌍이 온다, movesFor). */
  rename(moves: readonly Move[]): void {
    if (moves.length === 0) return;
    const map = new Map<string, string>();
    for (const m of moves) map.set(linkKey(m.from), m.to);
    const mapEntry = (e: NavEntry): NavEntry => {
      const to = map.get(linkKey(e.path));
      return to === undefined ? e : { path: to, line: e.line };
    };
    this.backStack = this.backStack.map(mapEntry);
    this.forwardStack = this.forwardStack.map(mapEntry);
  }

  canBack(): boolean {
    return this.backStack.length > 0;
  }

  canForward(): boolean {
    return this.forwardStack.length > 0;
  }
}
