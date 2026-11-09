/**
 * 그려진(셀 편집기가 들지 않은) 표 셀의 샘플 ID 표시(계획 Task 10, D7). 표 셀은 CodeMirror 가 아니라 renderInline 이
 * 그리므로, 강조 ViewPlugin(highlight.ts)과 같은 규칙의 범위를 클래스와 title 로만 넘긴다(CSP: 인라인 스타일 없음).
 * - 노트가 정의한 ID(`defined`)는 바깥 문서 전체에서 구하고, 문서와 종류가 같으면 다시 구하지 않는다.
 * - `sampleCellKey` 는 표 위젯이 셀을 다시 그려야 하는지 가리는 열쇠다: 설정·판·노트 경로·정의된 ID 가 바뀌면 바뀐다.
 */
import type { EditorState, Text } from '@codemirror/state';
import { findDefinedSampleIds } from '@labnoteo/core/lib/sampleStorage';
import type { InlineDecorator } from '../editor/table/renderInline';
import { coreT } from '../labnote/i18n';
import { sampleTokenRanges, type SampleHighlightInput } from '../labnote/port/sampleHighlightRanges';
import { sampleEditorConfig, sampleNotePath, type SampleEditorConfig } from './editorConfig';

/** 문서마다, 종류 열쇠마다 정의된 ID. */
const definedCache = new WeakMap<Text, { types: string; defined: ReadonlySet<string> }>();

function definedIn(state: EditorState, types: readonly string[]): ReadonlySet<string> {
  const key = types.join('\u0000');
  const hit = definedCache.get(state.doc);
  if (hit && hit.types === key) return hit.defined;
  const defined = findDefinedSampleIds(state.doc.toString(), types);
  definedCache.set(state.doc, { types: key, defined });
  return defined;
}

/** 이 상태에서 쓸 설정과 노트 경로. 설정이 없거나 이 노트가 켜져 있지 않으면 undefined. */
function active(state: EditorState): { cfg: SampleEditorConfig; path: string } | undefined {
  const cfg = state.facet(sampleEditorConfig);
  const path = state.facet(sampleNotePath);
  return cfg && cfg.enabled(path) ? { cfg, path } : undefined;
}

/** 설정 객체마다 번호(설정이 갈아 끼워지면 열쇠가 바뀐다). */
const configIds = new WeakMap<SampleEditorConfig, number>();
let nextConfigId = 1;
function configId(cfg: SampleEditorConfig): number {
  let id = configIds.get(cfg);
  if (id === undefined) configIds.set(cfg, (id = nextConfigId++));
  return id;
}

/** 표 셀을 꾸밀 함수. 설정이 없거나 이 노트가 켜져 있지 않으면 undefined. */
export function sampleCellDecorator(state: EditorState): InlineDecorator | undefined {
  const on = active(state);
  if (!on) return undefined;
  const { cfg, path } = on;
  const input: SampleHighlightInput = {
    types: cfg.types,
    known: cfg.known(path),
    defined: definedIn(state, cfg.types),
    titles: {
      missing: coreT('Not in the sample registry'),
      stale: (alias) => coreT('The registry calls this sample {0}', alias),
      discarded: (date) => coreT('Marked discarded on {0}', date),
    },
  };
  return (text) => sampleTokenRanges(text, input);
}

/**
 * 표 위젯의 `samplesKey`: 설정(정체성과 판)과 노트 경로, 노트가 정의한 ID. 설정이 없거나 꺼져 있으면 ''.
 * 정의된 ID 를 넣는 것은 표 밖에서 `@dna;DNA-9;…` 를 쓰면 표 안 DNA-9 의 "없음" 표시가 걷혀야 하기 때문이다.
 */
export function sampleCellKey(state: EditorState): string {
  const on = active(state);
  if (!on) return '';
  const { cfg, path } = on;
  const defined = [...definedIn(state, cfg.types)].sort().join('\u0001');
  return `${configId(cfg)}\u0000${cfg.version}\u0000${path}\u0000${defined}`;
}
