/**
 * 표를 CSV 로 내보내는 두 명령(플러그인 main.ts 의 'export-tables-csv', 'export-experiment-tables-csv').
 * 일은 port/exportCsv.ts 가 한다: 열린 노트 하나, 또는 열린 노트가 속한 실험의 모든 노트.
 * 파일 트리 메뉴의 같은 항목은 menus.ts 가 누른 노트나 폴더로 부른다.
 */
import { exportActiveExperimentTablesToCsv, exportActiveNoteTablesToCsv } from '../port/exportCsv';
import type { Command } from './registry';

export const exportCsvCommands: Command[] = [
  { id: 'export-tables-csv', nameKey: 'Export tables to CSV', run: exportActiveNoteTablesToCsv },
  {
    id: 'export-experiment-tables-csv',
    nameKey: 'Export all tables of this experiment to CSV',
    run: exportActiveExperimentTablesToCsv,
  },
];
