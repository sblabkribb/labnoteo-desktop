import { partbankCommands } from '../../partbank/commands';
import { aiCommands } from '../../ai/commands';
import { sampleCommands } from '../../samples/commands';
import { barcodeCommands } from '../barcode/commands';
import { scanCommands } from '../scan/commands';
import { catalogCommands } from './catalogs';
import { editorInsertCommands } from './editorInserts';
import { experimentCommands } from './experiment';
import { registerCommand, type Command } from './registry';
import { syncChecklistCommands } from './syncChecklist';
import { unitOpCommands } from './unitOp';
import { workflowCommands } from './workflow';

/**
 * 앱의 모든 명령. 명령 파일(Task 8 부터)은 여기에 자기 명령을 더한다.
 * 가져오기만으로는 아무것도 등록하지 않는다: VaultView 가 마운트할 때 registerAllCommands() 를 한 번 부른다.
 */
function allCommands(): Command[] {
  return [
    ...experimentCommands,
    ...workflowCommands,
    ...syncChecklistCommands,
    ...catalogCommands,
    ...unitOpCommands,
    ...editorInsertCommands,
    ...sampleCommands,
    ...partbankCommands,
    ...panelCommands,
    ...aiCommands,
    // SP7 Part A
    ...barcodeCommands,
    // SP7 Part B
    ...scanCommands,
  ];
}

/** 사이드바 패널 명령. 'open-workflow-view' 는 사이드바를 Workflows 탭으로 바꾼다(플러그인은 뷰를 연다). */
const panelCommands: Command[] = [
  { id: 'open-workflow-view', nameKey: 'Open workflow view', run: async (ctx) => ctx.showPanel('workflows') },
];

/** 모든 명령을 등록한다. 여러 번 불러도 id 마다 하나다(같은 id 는 바꿔 끼운다). */
export function registerAllCommands(): void {
  for (const c of allCommands()) registerCommand(c);
}
