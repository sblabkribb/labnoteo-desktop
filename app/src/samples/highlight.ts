/**
 * 샘플 ID 강조(계획 Task 9, D7). 모드 칸 밖에 두어 소스·라이브 모드 모두에서 그리고, 표 셀 편집기(cellExtras)에도 싣는다.
 * - 색은 종류 클래스(sampleTypeClass), 툴팁은 title 속성뿐이다(CSP: 인라인 스타일 없음).
 * - 조합 중(`view.composing || view.compositionStarted`)에는 장식을 옮기기만 하고 다시 만들지 않는다(LivePlugin 과 같다).
 * - 보이는 범위만 줄 단위로 훑는다. 노트가 정의한 ID(`defined`)는 문서 전체에서, 문서와 종류가 같으면 한 번만 구한다.
 * - 셀 편집기는 바깥 편집기의 설정과 노트 경로를 읽는다. 셀 편집기를 만드는 동안에는 바깥 편집기를 아직 모르므로
 *   한 번 마이크로태스크로 다시 그린다. 저장소 판이 오르거나 바깥 설정이 바뀌어도 같은 길로 다시 그린다.
 */
import type { EditorState, Extension, Range, Text } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { findDefinedSampleIds } from '@labnoteo/core/lib/sampleStorage';
import { getMode, subscribeMode } from '../editor/live/mode';
import { touchedLines } from '../editor/live/reveal';
import { langChanged } from '../editor/live/editorLang';
import { activeCellView, outerOf } from '../editor/table/cellEditor';
import { coreT } from '../labnote/i18n';
import { sampleTokenRanges, type SampleHighlightInput } from '../labnote/port/sampleHighlightRanges';
import { sampleEditorConfig, sampleNotePath, type SampleEditorConfig } from './editorConfig';
import { samples } from './sampleStore';

const composing = (view: EditorView) => view.composing || view.compositionStarted;

/** 이 편집기가 따르는 상태: 셀 편집기면 바깥 편집기의 것. */
function sourceState(view: EditorView): { state: EditorState; cell: boolean } {
  const outer = outerOf(view);
  return outer ? { state: outer.state, cell: true } : { state: view.state, cell: false };
}

/** 보이는 범위를 줄 경계로 넓히고 겹치거나 맞닿은 것을 합친다. */
function lineAlignedRanges(view: EditorView): Array<{ from: number; to: number }> {
  const doc = view.state.doc;
  const out: Array<{ from: number; to: number }> = [];
  for (const r of view.visibleRanges) {
    const from = doc.lineAt(r.from).from;
    const to = doc.lineAt(r.to).to;
    const prev = out[out.length - 1];
    if (prev && from <= prev.to) prev.to = Math.max(prev.to, to);
    else out.push({ from, to });
  }
  return out;
}

class SampleHighlightPlugin {
  decorations: DecorationSet = Decoration.none;
  /** 조합 중에 옮기기만 했다, 또는 다시 그리기를 청했다: 조합이 끝난 첫 갱신에서 다시 만든다. */
  pending = false;
  private drawnCfg: SampleEditorConfig | null = null;
  private drawnPath = '';
  private definedDoc: Text | undefined;
  private definedTypes = '';
  private defined: ReadonlySet<string> = new Set();
  private queued = false;
  private dead = false;
  private readonly off: () => void;
  private readonly offMode: () => void;
  /** 지난 그리기에서 커서가 닿은 줄(라이브 모드의 구분자 감추기는 이 줄을 건너뛴다). */
  private drawnLines = '';

  constructor(private readonly view: EditorView) {
    this.decorations = this.build(view);
    // 셀 편집기를 만드는 중이면 바깥 편집기를 아직 모른다(cellEditor.ts): 한 번 다시 그린다.
    if (outerOf(view) === null && view.state.facet(sampleNotePath) === '') this.requestRebuild();
    this.off = samples.subscribe(() => this.requestRebuild());
    this.offMode = subscribeMode(() => this.requestRebuild());
  }

  /** 다음 마이크로태스크에 빈 갱신으로 다시 그린다. 조합 중이면 조합이 끝난 뒤의 갱신에 맡긴다. */
  requestRebuild(): void {
    if (this.queued || this.dead) return;
    this.queued = true;
    this.pending = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.dead || composing(this.view)) return;
      this.view.dispatch({});
    });
  }

  update(u: ViewUpdate): void {
    if (composing(u.view)) {
      if (u.docChanged) this.decorations = this.decorations.map(u.changes);
      this.pending = true;
      return;
    }
    const { state, cell } = sourceState(u.view);
    const cfg = state.facet(sampleEditorConfig);
    const path = state.facet(sampleNotePath);
    // 화면 언어가 바뀌면 샘플 표시의 title(레지스트리에 없음 …)을 다시 단다
    const configChanged = cfg !== this.drawnCfg || path !== this.drawnPath || langChanged(u);
    // 라이브 모드에서 커서가 다른 줄로 가면 구분자 감추기가 달라진다(셀 편집기는 감추지 않는다).
    const linesChanged = !cell && u.selectionSet && getMode() === 'live' && lineKey(u.view) !== this.drawnLines;
    if (this.pending || u.docChanged || u.viewportChanged || configChanged || linesChanged) {
      this.decorations = this.build(u.view);
      this.pending = false;
    }
    // 바깥 편집기의 설정이 바뀌면 그 칸의 셀 편집기도 다시 그린다(셀 편집기는 바깥 설정을 따른다).
    if (configChanged && !cell) {
      const nested = activeCellView(u.view);
      nested?.plugin(sampleHighlightPlugin)?.requestRebuild();
    }
  }

  destroy(): void {
    this.dead = true;
    this.off();
    this.offMode();
  }

  private build(view: EditorView): DecorationSet {
    const { state, cell } = sourceState(view);
    const cfg = state.facet(sampleEditorConfig);
    const path = state.facet(sampleNotePath);
    // 라이브 모드의 바깥 편집기에서 커서가 닿지 않은 줄은 정의의 `;` 를 감춘다(아래 conceal).
    const conceal = !cell && getMode() === 'live';
    const touched = conceal ? touchedLines(view.state) : new Set<number>();
    this.drawnLines = conceal ? [...touched].join(',') : '';
    this.drawnCfg = cfg;
    this.drawnPath = path;
    if (!cfg || !cfg.enabled(path)) return Decoration.none;
    // 노트가 정의한 ID 는 노트 전체에서(셀 편집기면 바깥 문서): 화면 밖 정의도 아는 ID 다.
    const typesKey = cfg.types.join('\u0000');
    if (this.definedDoc !== state.doc || this.definedTypes !== typesKey) {
      this.defined = findDefinedSampleIds(state.doc.toString(), cfg.types);
      this.definedDoc = state.doc;
      this.definedTypes = typesKey;
    }
    const input: SampleHighlightInput = {
      types: cfg.types,
      known: cfg.known(path),
      defined: this.defined,
      titles: {
        missing: coreT('Not in the sample registry'),
        stale: (alias) => coreT('The registry calls this sample {0}', alias),
        discarded: (date) => coreT('Marked discarded on {0}', date),
      },
    };
    const doc = view.state.doc;
    const marks: Range<Decoration>[] = [];
    for (const { from, to } of lineAlignedRanges(view)) {
      const text = doc.sliceString(from, to);
      for (const r of sampleTokenRanges(text, input, from)) {
        marks.push(Decoration.mark({ class: r.cls, attributes: r.title ? { title: r.title } : undefined }).range(r.from, r.to));
        const syntax = definitionSyntax(text, r.from - from, r.to - from);
        const hide = conceal && syntax.length > 0 && !touched.has(doc.lineAt(r.from).number);
        syntax.forEach(([a, b], i) => {
          if (!hide) return void marks.push(syntaxMark.range(from + a, from + b));
          // 머리(`@dna;`)는 `@dna` 만 흐리게 두고 `;` 는 감춘다. ID·별칭 뒤의 `;` 는 흐린 가운뎃점으로 바꾼다.
          if (i === 0) {
            marks.push(syntaxMark.range(from + a, from + b - 1));
            marks.push(Decoration.replace({}).range(from + b - 1, from + b));
          } else marks.push(separator.range(from + a, from + b));
        });
      }
    }
    return Decoration.set(marks, true);
  }
}

/** 커서가 닿은 줄 번호들을 한 글로(바뀌었는지 견주는 데 쓴다). */
function lineKey(view: EditorView): string {
  return [...touchedLines(view.state)].join(',');
}

/** 라이브 모드에서 정의의 `;` 대신 그리는 흐린 가운뎃점. 파일 글은 그대로다. */
class SeparatorWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'lno-sample-syntax lno-sample-sep';
    el.textContent = '·';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}
const separator = Decoration.replace({ widget: new SeparatorWidget() });

/** 샘플 정의 줄의 문법 글자(`@dna;` 와 ID·별칭 뒤의 `;`): 흐리게 그려 ID 와 별칭이 먼저 읽히게 한다. 파일 글은 그대로다. */
const syntaxMark = Decoration.mark({ class: 'lno-sample-syntax' });
const DEFINITION_HEAD = /@[A-Za-z][\w-]*;$/;

/**
 * `@type;ID;alias;…` 에서 ID(`[idFrom, idTo)`) 둘레의 문법 글자 범위(text 안의 자리): 앞의 `@type;`, ID 바로 뒤의 `;`,
 * 같은 줄에서 그다음 `;`(별칭 끝). 정의 꼴이 아니면(앞에 `@type;` 이 없으면) 아무것도 없다.
 */
export function definitionSyntax(text: string, idFrom: number, idTo: number): Array<[number, number]> {
  const lineStart = text.lastIndexOf('\n', idFrom - 1) + 1;
  const head = DEFINITION_HEAD.exec(text.slice(lineStart, idFrom));
  if (!head) return [];
  const out: Array<[number, number]> = [[idFrom - head[0].length, idFrom]];
  if (text[idTo] !== ';') return out;
  out.push([idTo, idTo + 1]);
  const lineEnd = text.indexOf('\n', idTo);
  const next = text.indexOf(';', idTo + 1);
  if (next > idTo + 1 && (lineEnd < 0 || next < lineEnd)) out.push([next, next + 1]);
  return out;
}

const sampleHighlightPlugin = ViewPlugin.fromClass(SampleHighlightPlugin, { decorations: (p) => p.decorations });

/** 샘플 ID 강조(ViewPlugin + 장식). Editor 가 모드 칸 밖과 cellExtras 에 싣는다. */
export const sampleHighlight: Extension = sampleHighlightPlugin;
