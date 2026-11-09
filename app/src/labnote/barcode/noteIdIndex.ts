import { readNoteId } from '@labnoteo/core/lib/noteId';
import { frontMatterText } from '../frontMatterText';

/** 보관함의 `.md` 파일 하나: 경로('/' 구분), 확장자 `.md` 를 뗀 이름, 만든 시각(에포크 밀리초, 모르면 0). */
export interface NoteRef {
  path: string;
  basename: string;
  ctime: number;
}

export interface NoteIdIndexDeps {
  /** 보관함의 `.md` 파일 경로 전부(linkIndex.files() 를 `.md` 로 거른 것). */
  files(): Promise<string[]>;
  /** 원문 읽기. 열린 노트는 버퍼를 읽도록 editorAwareFs 의 read 를 준다. 없는 파일은 code `ENOENT` 로 거부한다. */
  read(path: string): Promise<string>;
  /** 경로마다 만든 시각(`vaultCreatedTimes`). 모르면 null. */
  ctimes(paths: string[]): Promise<Array<number | null>>;
}

/** 첫 빌드와 다시 빌드에서 한 번에 읽는 파일 수. */
export const NOTE_ID_READ_BATCH = 16;

/** `setNoteIdIndex` 전에 `noteIds()` 를 불렀다. */
export class NoNoteIdIndexError extends Error {
  constructor() {
    super('the note-ID index is not set up yet');
    this.name = 'NoNoteIdIndexError';
  }
}

interface Entry {
  ref: NoteRef;
  id: string | undefined;
}

const isMarkdown = (path: string) => path.endsWith('.md');

function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}

function isMissing(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'ENOENT';
}

/** `from`(파일 또는 폴더)의 항목을 `to` 로 옮긴다. 옮긴 것이 있으면 true. */
function moveEntries(entries: Map<string, Entry>, from: string, to: string): boolean {
  const entry = entries.get(from);
  if (entry) {
    entries.delete(from);
    if (isMarkdown(to)) entries.set(to, { ref: { ...entry.ref, path: to, basename: basenameOf(to) }, id: entry.id });
    return true;
  }
  const prefix = `${from}/`;
  const moved = [...entries.entries()].filter(([p]) => p.startsWith(prefix));
  for (const [p, e] of moved) {
    entries.delete(p);
    const next = `${to}/${p.slice(prefix.length)}`;
    entries.set(next, { ref: { ...e.ref, path: next }, id: e.id });
  }
  return moved.length > 0;
}

/** 그 파일 또는 폴더(안의 모든 경로)의 항목을 뺀다. */
function dropEntries(entries: Map<string, Entry>, path: string): void {
  entries.delete(path);
  const prefix = `${path}/`;
  for (const p of [...entries.keys()]) if (p.startsWith(prefix)) entries.delete(p);
}

/** 원문의 앞부분(front matter)에 적힌 올바른 `labnote_id`. 본문의 `labnote_id:` 는 세지 않는다. */
function idIn(raw: string): string | undefined {
  return readNoteId(frontMatterText(raw));
}

/**
 * 보관함의 모든 `.md` 노트와 그 `labnote_id` 를 들고 있는 동기 스냅숏(A5).
 * 첫 빌드는 `ready()` 에서 한 번(16 개씩 읽는다), 그 뒤로는 바뀐 경로만 `refresh` 로 다시 읽는다.
 * ID 는 앞부분에서만 읽으므로 본문에 `labnote_id:` 가 있어도 그 노트의 ID 가 아니다.
 */
export class NoteIdIndex {
  private readonly deps: NoteIdIndexDeps;
  private entries = new Map<string, Entry>();
  private building: Promise<void> | undefined;
  private built = false;
  /** 다시 빌드할 때마다 오른다: 그 전에 시작한 한 경로 refresh 의 결과는 버린다. */
  private generation = 0;
  /** 경로별 마지막 refresh 번호: 늦게 끝난 앞선 읽기가 새 결과를 덮지 않게 한다. */
  private latest = new Map<string, number>();
  private seq = 0;
  private readonly listeners = new Set<(path: string) => void>();
  /** 진행 중인 빌드마다 하나: 빌드가 읽는 동안 들어온 rename/drop. 빌드 결과에 다시 적용한다. */
  private readonly journals = new Set<Array<(m: Map<string, Entry>) => void>>();

  constructor(deps: NoteIdIndexDeps) {
    this.deps = deps;
  }

  /** 첫 빌드가 끝나면 풀린다. 여러 번 불러도 빌드는 한 번이다. */
  ready(): Promise<void> {
    this.building ??= this.build();
    return this.building;
  }

  /** 보관함의 모든 `.md` 파일. */
  refs(): readonly NoteRef[] {
    return [...this.entries.values()].map((e) => e.ref);
  }

  /** 그 경로 노트의 올바른 `labnote_id`(앞부분에서만). */
  idOf(path: string): string | undefined {
    return this.entries.get(path)?.id;
  }

  exists(path: string): boolean {
    return this.entries.has(path);
  }

  /**
   * 한 경로를 다시 읽는다. `''` 이면 전부 다시 빌드한다(`vault://changed` 의 빈 경로).
   * 없는 파일은 뺀다. 다른 이유로 읽지 못하면 이전 항목을 그대로 둔다(새 파일이면 ID 없이 넣는다).
   * ID 가 바뀌었거나 새로 생겼으면 그 뒤에 `onChange` 를 부른다.
   */
  async refresh(path: string): Promise<void> {
    if (path === '') {
      await this.ready();
      this.generation++;
      this.building = this.build();
      return this.building;
    }
    await this.ready();
    if (!isMarkdown(path)) return;
    const generation = this.generation;
    const token = ++this.seq;
    this.latest.set(path, token);
    let raw: string | undefined;
    let missing = false;
    try {
      raw = await this.deps.read(path);
    } catch (e) {
      missing = isMissing(e);
    }
    const prev = this.entries.get(path);
    let ctime: number | null | undefined = prev?.ref.ctime;
    if (!missing && !prev) ctime = (await this.safeCtimes([path]))[0];
    if (this.latest.get(path) !== token || this.generation !== generation) return;
    this.latest.delete(path);
    if (missing) {
      this.entries.delete(path);
      return;
    }
    if (raw === undefined) {
      if (!prev) this.entries.set(path, { ref: { path, basename: basenameOf(path), ctime: ctime ?? 0 }, id: undefined });
      return;
    }
    const id = idIn(raw);
    this.entries.set(path, { ref: prev?.ref ?? { path, basename: basenameOf(path), ctime: ctime ?? 0 }, id });
    if (id !== undefined && id !== prev?.id) this.emit(path);
  }

  /**
   * 파일 또는 폴더의 이름이 바뀌었다. 다시 읽지 않고 항목을 옮긴다(ID 와 만든 시각은 그대로).
   * 옛 경로에서 아직 읽고 있는 refresh 는 버린다(늦게 끝나 옛 경로를 되살리지 않게).
   * 진행 중인 다시 빌드에도 기록해 두었다가 그 결과에 다시 적용한다.
   */
  rename(from: string, to: string): void {
    this.forget(from);
    for (const journal of this.journals) journal.push((m) => moveEntries(m, from, to));
    const moved = moveEntries(this.entries, from, to);
    if (!moved && isMarkdown(to)) void this.refresh(to);
  }

  /** 파일 또는 폴더가 지워졌다. */
  drop(path: string): void {
    this.forget(path);
    for (const journal of this.journals) journal.push((m) => dropEntries(m, path));
    dropEntries(this.entries, path);
  }

  /** refresh 뒤 그 경로의 ID 가 바뀌었거나 새로 생겼을 때 불린다. 돌려준 함수로 끊는다. */
  onChange(fn: (path: string) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(path: string): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(path);
      } catch (e) {
        console.error('noteIdIndex listener', e);
      }
    }
  }

  /** 그 경로(폴더면 그 안의 경로까지)에서 진행 중인 refresh 의 결과를 버리게 한다. */
  private forget(path: string): void {
    const prefix = `${path}/`;
    for (const p of [...this.latest.keys()]) if (p === path || p.startsWith(prefix)) this.latest.delete(p);
  }

  private async safeCtimes(paths: string[]): Promise<Array<number | null>> {
    try {
      return await this.deps.ctimes(paths);
    } catch {
      return paths.map(() => null);
    }
  }

  /** 전부 읽는다. 첫 빌드가 아니면(다시 빌드) ID 가 바뀌었거나 새로 생긴 경로마다 `onChange` 를 부른다. */
  private async build(): Promise<void> {
    const generation = this.generation;
    const journal: Array<(m: Map<string, Entry>) => void> = [];
    this.journals.add(journal);
    let paths: string[];
    let ctimes: Array<number | null>;
    let ids: Array<string | undefined>;
    try {
      paths = (await this.deps.files()).filter(isMarkdown);
      [ctimes, ids] = await Promise.all([this.safeCtimes(paths), this.readAll(paths)]);
    } finally {
      this.journals.delete(journal);
    }
    if (this.generation !== generation) return;
    const before = this.entries;
    const next = new Map<string, Entry>();
    paths.forEach((path, i) => {
      next.set(path, { ref: { path, basename: basenameOf(path), ctime: ctimes[i] ?? 0 }, id: ids[i] });
    });
    for (const op of journal) op(next);
    this.entries = next;
    const notify = this.built;
    this.built = true;
    if (!notify) return;
    for (const [path, e] of next) if (e.id !== undefined && e.id !== before.get(path)?.id) this.emit(path);
  }

  /** `NOTE_ID_READ_BATCH` 개 이하를 동시에 읽는다. 읽지 못한 파일은 ID 가 없다. */
  private async readAll(paths: string[]): Promise<Array<string | undefined>> {
    const out = new Array<string | undefined>(paths.length);
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const i = next++;
        try {
          out[i] = idIn(await this.deps.read(paths[i]));
        } catch {
          out[i] = undefined;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(NOTE_ID_READ_BATCH, paths.length) }, worker));
    return out;
  }
}

let current: NoteIdIndex | undefined;

/** 앱의 노트 ID 색인. `setNoteIdIndex` 전에는 `NoNoteIdIndexError` 를 던진다. */
export function noteIds(): NoteIdIndex {
  if (!current) throw new NoNoteIdIndexError();
  return current;
}

/** 지금 놓인 색인. 없으면 undefined(던지지 않는다: 보관함을 닫을 때 제 색인인지 보는 데 쓴다). */
export function currentNoteIdIndex(): NoteIdIndex | undefined {
  return current;
}

/** 보관함을 열 때 색인을 놓고, 닫을 때 `undefined` 로 치운다(App.tsx 의 SP7 Part A 블록). */
export function setNoteIdIndex(index: NoteIdIndex | undefined): void {
  current = index;
}
