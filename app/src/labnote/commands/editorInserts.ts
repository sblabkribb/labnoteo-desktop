/**
 * 편집기 명령: 날짜 넣기(insert-date), 날짜와 시간 넣기(insert-datetime), 논의 이슈 마커 넣기(insert-issue-marker).
 * 플러그인 commands.ts 의 insertDateCommand(846-913), insertIssueMarkerCommand(928-1030)와 main.ts 의
 * insertDateFromPalette / insertIssueMarkerFromPalette(419-475)를 본뜬 앱의 오케스트레이터다. 앱에서 달라진 것:
 * - Obsidian 의 Editor 대신 CodeMirror 뷰(ctx.activeView()). 오프셋은 `state.doc.toString()`(LF 로 이은 글) 기준이다.
 * - 편집은 트랜잭션 한 번, 되돌리기 한 번(isolateHistory 'full'). 넣는 글의 줄바꿈은 문서의 줄 구분자로 바꾼다.
 * - 표 칸: 플러그인의 셀 편집기 대신 SP1 의 셀 편집기(activeCellView). 그 편집기에 쓰면 바깥 문서로 한 트랜잭션으로 간다.
 * - 노트가 열려 있지 않을 때의 문장은 앱 문장(overrideOr). 채워진 Meta 날짜의 거절도 앱 문장(📅 고르개가 없다).
 * - 편집기가 바쁘면(읽는 중, 풀리지 않은 바깥 변경) command.noteBusy 를 알리고 아무것도 하지 않는다.
 * - 자동화 안내는 세션에 한 번, 'no-git' 일 때만. "Setup research automation" 안내는 앱에 그 명령이 없어 내지 않는다.
 */
import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  endsAliasedReference,
  generateIssueMarkerId,
  issueSentenceRange,
  lineHasSampleReference,
  MAX_ISSUE_TOPIC,
  parseIssueMarkers,
  planDateInsertion,
  planIssueMarkerInsertion,
} from '@labnoteo/core';
import { findMetaDateFieldInLine, findPairedMetaDate, getSeoulDateString, getSeoulDateTimeString, isEndBeforeStart } from '@labnoteo/core/lib/dateUtils';
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import { isWorkflowChecklistEntryLine, workflowChecklistEntryLabel } from '@labnoteo/core/lib/workflowStructure';
import { markerExperimentDir } from '../../../vendor/labnoteo/src/issueMarkerIndex';
import { activeCellView } from '../../editor/table/cellEditor';
import { t } from '../../i18n/t';
import { toDocBreaks } from '../editTarget';
import { overrideOr } from '../i18n';
import { openNote } from '../openNotes';
import { SETUP_DOC_PATH, issueAutomationState } from '../port/issueAutomation';
import type { CommandContext } from './context';
import type { Command } from './registry';

/** 명령이 만든 편집: 되돌리기 한 번, 사용자 입력과 구별되는 userEvent. */
const COMMAND_EDIT = () => [isolateHistory.of('full'), Transaction.userEvent.of('input.labnote')];

type Resolved = { view: EditorView; path: string } | 'noNote' | 'busy';

/** 열린 노트와 그 뷰. 노트가 편집기에 열려 있는데 뷰가 없으면(바쁘면) 'busy'. */
function resolve(ctx: CommandContext): Resolved {
  const path = ctx.activePath();
  if (!path) return 'noNote';
  const view = ctx.activeView();
  if (view) return { view, path };
  return openNote(path) ? 'busy' : 'noNote';
}

/**
 * 선택 위에 날짜(또는 날짜와 시간)를 넣는다. 앞부분(front matter)에서는 비어 있는 날짜 키만 채우고, 그 밖에는 YAML 을
 * 깨므로 거절한다(#106). 넣었는지를 돌려준다.
 */
export function insertDate(ctx: CommandContext, now: () => string): boolean {
  const { host } = ctx;
  const r = resolve(ctx);
  if (r === 'busy') {
    host.notify('warn', t('command.noteBusy'));
    return false;
  }
  if (r === 'noNote') {
    // plugin: 'Switch to the editing view and put the cursor where the date goes, then run this again.'
    host.notify('info', overrideOr('insertDate.noNote'));
    return false;
  }
  const { view: editor } = r;
  const text = now();
  const types = getSampleDisplayMeta(ctx.settings.customSampleTypes).types;

  // 표 칸에는 그 칸만 든 셀 편집기가 따로 있다(#303): 그것에 쓴다. 바깥 오프셋은 표의 다른 곳에 닿는다.
  // 아래의 앞부분·Meta 검사는 칸을 노트로 읽으므로 건너뛴다.
  const cell = activeCellView(editor);
  if (cell) {
    const from = cell.state.selection.main.from;
    const lineBefore = cell.state.doc.toString().slice(0, from).split('\n').pop() ?? '';
    cell.dispatch(cell.state.replaceSelection(endsAliasedReference(lineBefore, types) ? ` ${text}` : text), {
      annotations: Transaction.userEvent.of('input.labnote'),
    });
    // 셀 편집기는 바깥 문서에 바뀐 글자를 한 트랜잭션으로 넘긴다. 다음 입력이 이 날짜에 합쳐지지 않게 기록을 끊는다.
    editor.dispatch({ annotations: isolateHistory.of('after') });
    return true;
  }

  const state = editor.state;
  const doc = state.doc.toString();
  const plan = planDateInsertion(doc, state.selection.main.from, state.selection.main.to, text, types);
  if ('reason' in plan) {
    host.notify(
      'warn',
      plan.reason === 'metaDate'
        ? // plugin: 'This Start_date/End_date already has a value. Use the 📅 picker next to it to change the date.'
          overrideOr('insertDate.metaDateFilled')
        : plan.reason === 'notDateKey'
          ? host.t(
              '{0} is not a date field, so no date was put there. Run this on an empty date line such as end_date, or in the body.',
              plan.key,
            )
          : plan.reason === 'listValue'
            ? host.t(
                '{0} has its value on the lines below, such as a list, so no date was put on its line. Add the date as a new "- " item under it.',
                plan.key,
              )
            : host.t('A date cannot go on a front matter line that has a value. Run this in the body or on an empty value.'),
    );
    return false;
  }
  // 한 트랜잭션: 두 번째 dispatch 는 이미 바뀐 편집기에 닿을 수 있다(#303).
  editor.dispatch({
    changes: { from: plan.from, to: plan.to, insert: toDocBreaks(plan.text, state) },
    selection: { anchor: plan.from + plan.text.length },
    annotations: COMMAND_EDIT(),
  });
  // 📅 고르개처럼, End_date 가 Start_date 보다 앞서면 알린다(#531).
  const docLines = editor.state.doc.toString().split('\n');
  const lineIndex = editor.state.doc.lineAt(plan.from).number - 1;
  const own = findMetaDateFieldInLine(docLines[lineIndex] ?? '');
  const other = own ? findPairedMetaDate(docLines, lineIndex) : undefined;
  if (own && other) {
    const [start, finish] = own.field === 'End_date' ? [other.value, own.value] : [own.value, other.value];
    if (isEndBeforeStart(start, finish)) {
      host.notify('warn', host.t('End_date {0} is earlier than Start_date {1}.', finish, start));
    }
  }
  return true;
}

/** 이 세션에서 자동화 안내를 이미 보였는가(플러그인의 issueAutomationHintShown). */
let issueAutomationHintShown = false;

export function resetIssueHintForTest(): void {
  issueAutomationHintShown = false;
}

/**
 * 선택에 대한 `@issue` 마커를 새 ID 로 넣는다. 선택이 없으면 주제를 묻는다(그 줄의 문장으로 채워). 넣었는지를 돌려준다.
 * 마커가 들어갈 곳은 planIssueMarkerInsertion 이 정한다. 주 선택만 쓴다: 명령 한 번에 ID 하나.
 */
export async function insertIssueMarker(ctx: CommandContext): Promise<boolean> {
  const { host } = ctx;
  const first = resolve(ctx);
  if (first === 'busy') {
    host.notify('warn', t('command.noteBusy'));
    return false;
  }
  if (first === 'noNote') {
    // plugin: 'Switch to the editing view and put the cursor on the line to discuss, then run this again.'
    host.notify('info', overrideOr('issueMarker.noNote'));
    return false;
  }
  const { path: notePath } = first;

  const newId = (doc: string): string => {
    const used = new Set(parseIssueMarkers(doc).markers.map((m) => m.id));
    let id = generateIssueMarkerId();
    while (used.has(id)) id = generateIssueMarkerId();
    return id;
  };
  const refuse = (reason: 'conflict' | 'table' | 'frontMatter' | 'codeBlock' | 'comment' | 'notLabnote'): false => {
    host.notify(
      'warn',
      reason === 'notLabnote'
        ? host.t(
            'Markers in this note open no issue: only the README and workflow notes (.labnote.md) directly in an experiment folder are read. Put the marker in one of those.',
          )
        : reason === 'table'
          ? host.t('Issue markers cannot go inside a table. Run this on a line below the table.')
          : reason === 'frontMatter'
            ? host.t('Issue markers cannot go in the front matter. Run this in the note body.')
            : reason === 'codeBlock'
              ? host.t('Issue markers inside a code block open no issue. Run this on a line outside the code block.')
              : reason === 'comment'
                ? host.t('Issue markers inside a comment open no issue. Run this on a line outside the comment.')
                : host.t('This line already has an issue marker. A line can hold only one.'),
    );
    return false;
  };

  // issue-sync 와 validate 는 이 노트들만 읽는다(#428).
  if (!markerExperimentDir(notePath)) return refuse('notLabnote');

  // README 의 워크플로 항목에서 링크가 마커가 되면 더는 항목이 아니다(#293): 거기서는 마커가 늘 링크 뒤로 간다.
  const lineAt = (text: string, offset: number): string => {
    const nl = text.indexOf('\n', offset);
    return text.slice(text.lastIndexOf('\n', offset - 1) + 1, nl === -1 ? text.length : nl);
  };

  let editor = first.view;
  let doc = editor.state.doc.toString();
  const { from, to } = editor.state.selection.main;
  let plan;
  if (from !== to) {
    const selected = doc.slice(from, to);
    plan =
      !selected.includes('\n') && isWorkflowChecklistEntryLine(lineAt(doc, from))
        ? planIssueMarkerInsertion(doc, to, to, newId(doc), selected)
        : planIssueMarkerInsertion(doc, from, to, newId(doc));
  } else {
    // 마커를 받을 수 없는 줄은 주제를 묻기 전에 거절한다.
    const probe = planIssueMarkerInsertion(doc, from, to, newId(doc), '-');
    if ('reason' in probe) return refuse(probe.reason);
    const topic = (
      await host.prompt({
        title: host.t('Issue topic sentence'),
        prompt: host.t('This sentence becomes the issue title. Keep the sentence from this line or type another.'),
        // 시료 참조는 주제가 아니라 데이터다(#373).
        value:
          workflowChecklistEntryLabel(lineAt(doc, from)) ??
          (lineHasSampleReference(lineAt(doc, from)) ? '' : (issueSentenceRange(doc, from)?.text ?? '')),
        validate: (v) => (v.trim() ? null : host.t('Enter the topic sentence of the issue.')),
      })
    )?.trim();
    if (!topic) return false;
    // 묻는 사이 노트가 바뀌었을 수 있다: 다시 읽는다. 편집기가 바빠졌거나 다른 노트로 옮겨 갔으면 넣지 않는다.
    const again = resolve(ctx);
    if (again === 'busy') {
      host.notify('warn', t('command.noteBusy'));
      return false;
    }
    if (again === 'noNote' || again.path !== notePath) {
      host.notify('info', overrideOr('issueMarker.noNote'));
      return false;
    }
    editor = again.view;
    doc = editor.state.doc.toString();
    const caret = editor.state.selection.main.from;
    const sentence = issueSentenceRange(doc, caret);
    plan =
      sentence && sentence.text === topic && !isWorkflowChecklistEntryLine(lineAt(doc, caret))
        ? // 문장을 고른 것처럼: 그 문장이 마커가 된다.
          planIssueMarkerInsertion(doc, sentence.from, sentence.to, newId(doc))
        : // 새 문장이면 줄은 쓴 그대로 둔다.
          planIssueMarkerInsertion(doc, caret, caret, newId(doc), topic);
  }
  if ('reason' in plan) return refuse(plan.reason);

  const { edit, cursor } = plan;
  const state = editor.state;
  const insert = toDocBreaks(edit.insert, state);
  editor.dispatch({
    changes: { from: edit.from, to: edit.to, insert },
    selection: { anchor: cursor },
    annotations: COMMAND_EDIT(),
  });
  // GitHub 은 실험 ID 를 포함해 256 자까지의 제목을 받는다(#475).
  const topic = parseIssueMarkers(edit.insert).markers[0]?.title ?? '';
  const length = Array.from(topic).length;
  if (length > MAX_ISSUE_TOPIC) {
    host.notify(
      'warn',
      host.t(
        'The topic sentence is {0} characters long. The issue title takes about {1}, so it will be shortened there; the whole sentence goes in the issue body.',
        String(length),
        String(MAX_ISSUE_TOPIC),
      ),
    );
  }

  if (!issueAutomationHintShown && (await issueAutomationState(host)) === 'no-git') {
    issueAutomationHintShown = true;
    host.notify(
      'info',
      host.t(
        'Issue marker inserted. This vault is not a git repository yet, so no issue will open. Finish the repository setup in {0} first.',
        SETUP_DOC_PATH,
      ),
    );
  }
  return true;
}

export const editorInsertCommands: Command[] = [
  { id: 'insert-date', nameKey: 'Insert date', icon: 'calendar', run: async (ctx) => insertDate(ctx, getSeoulDateString) },
  { id: 'insert-datetime', nameKey: 'Insert date and time', icon: 'clock', run: async (ctx) => insertDate(ctx, getSeoulDateTimeString) },
  { id: 'insert-issue-marker', nameKey: 'Insert issue marker', icon: 'triangle-alert', run: (ctx) => insertIssueMarker(ctx) },
];
