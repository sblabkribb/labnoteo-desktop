/**
 * `@` 샘플 완성(plan SP5 Task 13, D9, D10). `@DNA;`, `@Plasmid:`, `@sample`, `@item`, 사용자 종류(`@배지;`) 뒤에서
 * 등록된 후보 출처(`sources.ts`)의 줄을 모아 쓰고 있는 샘플 → 동작(카탈로그 검색, 새 ID 생성, 직접 입력, …) → 폐기된 샘플
 * 순서로 보인다.
 *
 * - 소스는 조합 중에도 돈다(한글 음절이 조합되는 동안에도 목록이 열려 거른다). 받아들이기는 조합이 끝난 뒤에만 한다.
 * - 표 칸 안(`inTable`)에서는 넣는 글의 파이프를 escape 한다(`escapeSamplePipes`): 행의 칸 수가 바뀌지 않는다.
 * - 동작 줄은 대화상자를 거쳐 늦게 결과를 낸다. 그동안 트리거 범위는 `pendingSampleInsert` 가 모든 변경에 따라 옮긴다.
 *   결과가 오면 편집기가 그대로 있고, 노트가 같고, 옮긴 범위의 글이 처음과 같을 때만 넣는다. 아니면 클립보드에 복사하고
 *   알린다(D9): 참조가 소리 없이 사라지지 않는다.
 */
import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { closeCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { parseSampleTrigger } from '@labnoteo/core';
import { escapeSamplePipes } from '@labnoteo/core/lib/sampleUtils';
import { inCode, inTable, type ReopenIf } from '../links/complete';
import { copyText } from '../links/clipboard';
import { outerOf } from '../editor/table/cellEditor';
import { t } from '../i18n/t';
import { sampleEditorConfig, sampleNotePath, type SampleEditorConfig } from './editorConfig';
import type { SampleEnv } from './env';
import { orderRows, sampleQueryAt, sampleSources, type SampleActionRow, type SampleExistingRow, type SampleQuery, type SampleRow } from './sources';

export interface SampleCompletionDeps {
  notePath(): string;
  config(state: EditorState): SampleEditorConfig | null;
  env(): SampleEnv | undefined;
}

type ApplyFn = (view: EditorView, completion: Completion, from: number, to: number) => void;

/**
 * A sample option. `Completion` has no `class` field in @codemirror/autocomplete 6.20, so the class rides on the option
 * and `sampleOptionClass` (the editor's `autocompletion({ optionClass })`) puts it on the `<li>`.
 */
export interface SampleCompletion extends Completion {
  class: string;
}

/** `autocompletion({ optionClass })`: a sample option's class, '' for every other option. */
export function sampleOptionClass(completion: Completion): string {
  const cls = (completion as Partial<SampleCompletion>).class;
  return typeof cls === 'string' ? cls : '';
}

const OPTION_CLASS = 'lno-sample-option';
const DISCARDED_CLASS = `${OPTION_CLASS} lno-sample-option-discarded`;

/** 이 편집기가 따르는 상태: 셀 편집기면 바깥 편집기의 것(설정 퍼싯은 바깥 편집기에 있다). */
function noteState(view: EditorView | undefined, state: EditorState): EditorState {
  const outer = view ? outerOf(view) : null;
  return outer ? outer.state : state;
}

// ---- pendingSampleInsert -------------------------------------------------------------------------------------------

export interface PendingSampleInsert {
  id: number;
  path: string;
  from: number;
  to: number;
  original: string;
}

const addPending = StateEffect.define<PendingSampleInsert>();
const removePending = StateEffect.define<number>();

/** Ranges awaiting an action result, mapped through every change. */
export const pendingSampleInsert = StateField.define<ReadonlyArray<PendingSampleInsert>>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.length > 0) {
      // 트리거 앞에 들어온 글은 범위를 민다(from: assoc 1), 트리거 끝에 붙은 글은 범위에 넣지 않는다(to: assoc -1).
      next = next.map((p) => {
        const from = tr.changes.mapPos(p.from, 1);
        return { ...p, from, to: Math.max(from, tr.changes.mapPos(p.to, -1)) };
      });
    }
    for (const e of tr.effects) {
      if (e.is(addPending)) next = [...next, e.value];
      else if (e.is(removePending)) next = next.filter((p) => p.id !== e.value);
    }
    return next;
  },
});

let nextPendingId = 1;

/** 조합이 끝날 때까지 기다린다(조합 중에는 문서에 넣지 않는다). 편집기가 없어지면 바로 끝난다. */
function afterComposition(view: EditorView): Promise<void> {
  if (!(view.composing || view.compositionStarted)) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!view.dom.isConnected || !(view.composing || view.compositionStarted)) resolve();
      else setTimeout(check, 50);
    };
    view.contentDOM.addEventListener('compositionend', () => setTimeout(check, 0), { once: true });
    setTimeout(check, 50);
  });
}

// ---- apply -----------------------------------------------------------------------------------------------------------

/** 쓰고 있는(또는 폐기된) 샘플: `ID;alias` 를 넣는다. 폐기된 샘플이면 폐기일을 알린다. */
function applyExisting(row: SampleExistingRow, env: SampleEnv): ApplyFn {
  return (view, _c, from, to) => {
    if (view.composing) return; // D9: 조합 중에는 받아들이지 않는다
    const { insertText, id, discarded } = row.entry;
    const insert = inTable(view.state, from, view) ? escapeSamplePipes(insertText) : insertText;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
    if (discarded) env.host.notify('info', env.t('{0} was marked discarded on {1}.', id, discarded));
  };
}

/** 동작 줄(D9): 목록을 닫고, 범위를 기억해 두고, 대화상자의 결과를 기다려 옮긴 범위에 넣는다. */
function applyAction(row: SampleActionRow, q: SampleQuery, env: SampleEnv, deps: SampleCompletionDeps): ApplyFn {
  return (view, _c, from, to) => {
    if (view.composing) return;
    closeCompletion(view);
    const id = nextPendingId++;
    const path = q.notePath;
    view.dispatch({ effects: addPending.of({ id, path, from, to, original: view.state.sliceDoc(from, to) }) });
    void (async () => {
      let ref: string | undefined;
      try {
        ref = await row.run(q);
      } catch (e) {
        env.host.notify('warn', e instanceof Error ? e.message : String(e));
      }
      if (ref) await afterComposition(view);
      const connected = view.dom.isConnected;
      const pending = connected ? view.state.field(pendingSampleInsert, false)?.find((p) => p.id === id) : undefined;
      if (pending) view.dispatch({ effects: removePending.of(id) });
      if (!ref) return;
      const fits =
        pending !== undefined && deps.notePath() === pending.path && view.state.sliceDoc(pending.from, pending.to) === pending.original;
      if (!fits) {
        env.host.notify('warn', t('samples.insertDropped', ref));
        try {
          await copyText(ref, (kind, message) => env.host.notify(kind, message));
        } catch {
          // 클립보드가 거부했다: 위의 알림에 참조가 그대로 있다
        }
        return;
      }
      const insert = inTable(view.state, pending.from, view) ? escapeSamplePipes(ref) : ref;
      view.dispatch({
        changes: { from: pending.from, to: pending.to, insert },
        selection: { anchor: pending.from + insert.length },
        userEvent: 'input.complete',
        scrollIntoView: true,
      });
    })();
  };
}

function toOption(row: SampleRow, q: SampleQuery, env: SampleEnv, deps: SampleCompletionDeps): SampleCompletion {
  if (row.kind === 'action') {
    return { label: row.label, detail: row.detail, class: OPTION_CLASS, apply: applyAction(row, q, env, deps) };
  }
  const { label, type, scope, discarded } = row.entry;
  // 플러그인 renderSuggestion 과 같은 설명(scope 가 없으면 `${type} Sample`).
  const base = scope ? env.t(scope === 'local' ? 'Local {0} sample' : 'Global {0} sample', type) : `${type} Sample`;
  return {
    label,
    detail: discarded ? `${base} · ${env.t('Discarded')}` : base,
    class: discarded ? DISCARDED_CLASS : OPTION_CLASS,
    apply: applyExisting(row, env),
  };
}

// ---- source ----------------------------------------------------------------------------------------------------------

export function sampleCompletionSource(deps: SampleCompletionDeps): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const env = deps.env();
    if (!env) return null;
    const { state, pos } = context;
    const cfg = deps.config(noteState(context.view, state));
    if (!cfg || cfg.types.length === 0) return null;
    const notePath = deps.notePath();
    if (!cfg.enabled(notePath)) return null;
    const line = state.doc.lineAt(pos);
    const lineBefore = line.text.slice(0, pos - line.from);
    if (!lineBefore.includes('@')) return null;
    if (inCode(state, pos, lineBefore)) return null;
    const q = sampleQueryAt(lineBefore, notePath, cfg.types);
    if (!q) return null;
    const rows: SampleRow[] = [];
    for (const source of sampleSources()) {
      try {
        rows.push(...(await source.rows(q, env)));
      } catch {
        // 한 출처가 실패해도 나머지 줄은 보인다
      }
    }
    const ordered = orderRows(rows);
    if (ordered.length === 0) return null;
    return {
      from: line.from + q.trigger.startCol,
      filter: false,
      options: ordered.map((row) => toOption(row, q, env, deps)),
    };
  };
}

/** compositionend 뒤에 목록을 다시 연다: 이 편집기의 설정 종류로 커서 앞 글이 샘플 트리거일 때. */
export const sampleReopen: ReopenIf = (lineBefore, view) => {
  if (!lineBefore.includes('@')) return false;
  const state = noteState(view, view.state);
  const cfg = state.facet(sampleEditorConfig);
  if (!cfg || cfg.types.length === 0) return false;
  if (!cfg.enabled(state.facet(sampleNotePath))) return false;
  return parseSampleTrigger(lineBefore, cfg.types) !== undefined;
};
