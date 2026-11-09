/**
 * 쓰기 허용 질문 포트(vendor tests/plugin/mcpServer.test.ts 의 describe('buildApprovalMessage') 를 옮겼다).
 * 'Lines removed:' 처럼 콜론 바로 뒤에 줄바꿈 이스케이프가 오는 기대 글은 escapes.test.ts 가 드라이브 경로로 보므로 줄 배열을 join 한다.
 * 플러그인의 createObsidianTranslator('en' | 'ko') 대신 같은 목록(l10n.ko.ts)으로 만든 코어 번역기를 쓴다.
 */
import { describe, it, expect } from 'vitest';
import { createTranslator } from '@labnoteo/core';
import obsidianKo from '../../../vendor/labnoteo/src/l10n.ko';
import { buildApprovalMessage, erasesRecordedLines } from '../../labnote/port/approvalMessage';

const createObsidianTranslator = (lang: 'ko' | 'en') => (lang === 'ko' ? createTranslator(obsidianKo) : createTranslator());

describe('buildApprovalMessage', () => {
  const t = createObsidianTranslator('en');
  const preview = {
    kind: 'sectionEdit' as const,
    documentPath: 'n.md',
    heading: 'Results',
    parentHeading: '[UHW100 PCR]',
    occurrence: 1,
    total: 1,
    line: 8,
    removedLines: 12,
    removedSubheadings: 0,
    clearing: false,
    removedText: [] as string[],
    removedMore: 0,
    addedText: [] as string[],
    addedMore: 0,
  };
  const NONE_REMOVED = 'No recorded lines are removed.';

  it('adds the target and what the section holds now', () => {
    expect(buildApprovalMessage(t, 'Allow?', 'n.md', preview)).toBe(
      `Allow?\n\nTarget: n.md\n\nThis replaces section "[UHW100 PCR] > Results", which now has 12 line(s).\n\n${NONE_REMOVED}`
    );
  });

  // #554
  it('says an append adds to the end of the section', () => {
    const msg = buildApprovalMessage(t, 'Allow?', null, { ...preview, appending: true, addedText: ['- [review] ok'] });
    expect(msg).toContain('This adds to the end of section "[UHW100 PCR] > Results", which now has 12 line(s).');
    expect(msg).toContain(NONE_REMOVED);
    expect(msg).toContain(['Lines added:', '  - [review] ok'].join('\n'));
    expect(buildApprovalMessage(createObsidianTranslator('ko'), 'Allow?', null, { ...preview, appending: true })).toContain(
      '절 "[UHW100 PCR] > Results"의 끝에 덧붙입니다.'
    );
  });

  it('says when the section is emptied and nested headings go with it', () => {
    expect(
      buildApprovalMessage(t, 'Allow?', null, { ...preview, parentHeading: '', clearing: true, removedSubheadings: 2 })
    ).toBe(
      `Allow?\n\nThis empties section "Results", which now has 12 line(s). Its 2 nested heading(s) are replaced too.\n\n${NONE_REMOVED}`
    );
  });

  // #187
  it('lists the lines removed and added', () => {
    const msg = buildApprovalMessage(t, 'Allow?', null, {
      ...preview,
      removedText: ['memo', 'DNA-1;frag'],
      removedMore: 3,
      addedText: ['new line'],
    });
    expect(msg).toContain(['Lines removed:', '  memo', '  DNA-1;frag', '  (+3 more line(s))'].join('\n'));
    expect(msg).toContain(['Lines added:', '  new line'].join('\n'));
    expect(msg).not.toContain(NONE_REMOVED);
  });

  it('is just the prompt and target without a preview', () => {
    expect(buildApprovalMessage(t, 'Allow?', 'n.md')).toBe('Allow?\n\nTarget: n.md');
  });

  // #114
  it('says which repeated section it is', () => {
    expect(buildApprovalMessage(t, 'Allow?', null, { ...preview, occurrence: 2, total: 3, line: 83 })).toBe(
      `Allow?\n\nThis replaces section "[UHW100 PCR] > Results", which now has 12 line(s). It is occurrence 2 of 3, with its heading on line 83.\n\n${NONE_REMOVED}`
    );
  });

  // #113
  describe('create_sample', () => {
    const sample = {
      kind: 'sampleCreate' as const,
      type: 'Reagent',
      existing: false,
      folder: 'labnote/049_M/resources/labsamples',
      scope: 'local' as const,
    };

    it('names the type, alias, location and folder of a new sample', () => {
      expect(
        buildApprovalMessage(t, 'Allow?', 'n.md', { ...sample, alias: '배지성분-1', location: '선반-M / 칸-1' })
      ).toBe(
        'Allow?\n\nTarget: n.md\n\nThis creates a Reagent sample with a new ID.\nAlias: 배지성분-1\nStorage location: 선반-M / 칸-1\nSaved in the local samples folder labnote/049_M/resources/labsamples.'
      );
    });

    it('tells a given id apart from adding to an existing one', () => {
      expect(buildApprovalMessage(t, 'Allow?', null, { ...sample, id: 'Reagent-3' })).toContain(
        'This creates Reagent sample Reagent-3.'
      );
      expect(
        buildApprovalMessage(t, 'Allow?', null, { ...sample, id: 'Reagent-3', existing: true, scope: 'global', folder: 'g' })
      ).toBe('Allow?\n\nThis adds to Reagent sample Reagent-3.\nSaved in the global samples folder g.');
    });

    // #310
    it('says which samples already have the alias', () => {
      expect(buildApprovalMessage(t, 'Allow?', null, { ...sample, alias: 'LB', aliasTwins: ['Reagent-1', 'Reagent-4'] })).toContain(
        'Alias: LB\nThis experiment already has the alias LB (Reagent-1, Reagent-4).'
      );
      expect(
        buildApprovalMessage(t, 'Allow?', null, { ...sample, alias: 'LB', aliasTwins: ['Reagent-1'], scope: 'global', folder: 'g' })
      ).toContain('Global samples already have the alias LB (Reagent-1).');
    });
  });

  // #124
  it('names the catalog workflow, the new file and the README of create_workflow', () => {
    const readmePath = 'labnote/043_X/README.labnote.md';
    expect(
      buildApprovalMessage(t, 'Allow?', readmePath, {
        kind: 'workflowCreate',
        workflowId: 'WT110',
        workflowName: 'Micro-scale Parallel Cell Fermentation',
        fileName: '002_WT110_Micro-scale_Parallel_Cell_Fermentation.labnote.md',
        readmePath,
      })
    ).toBe(
      `Allow?\n\nTarget: ${readmePath}\n\nThis creates catalog workflow WT110 Micro-scale Parallel Cell Fermentation. ` +
        `File: 002_WT110_Micro-scale_Parallel_Cell_Fermentation.labnote.md. It is also added to the checklist in ${readmePath}.`
    );
  });

  // #484
  it('says, as the app does, when create_workflow repeats an ID and alias', () => {
    const readmePath = 'labnote/043_X/README.labnote.md';
    const message = buildApprovalMessage(t, 'Allow?', readmePath, {
      kind: 'workflowCreate',
      workflowId: 'WT030',
      workflowName: 'Wet Validation',
      fileName: '003_WT030_Wet_Validation_상위_8종.labnote.md',
      readmePath,
      sameAliasAs: '002_WT030_Wet_Validation_상위_8종.labnote.md',
    });
    expect(message.split('\n').at(-1)).toBe(
      '002_WT030_Wet_Validation_상위_8종.labnote.md already has this ID and alias, so the two would read the same in the README checklist. Give this one its own alias to tell them apart.'
    );
  });

  // #491
  describe('insert_unit_operation', () => {
    const notePath = 'labnote/043_X/001_WD010_Design.labnote.md';
    const insert = {
      kind: 'unitOpInsert' as const,
      documentPath: notePath,
      opId: 'UHW010',
      opName: 'Liquid Handling',
      opType: 'hw' as const,
      place: 'end' as const,
      after: '[UHW015 Bulk Liquid Dispenser]',
    };

    it('names the block, the note and where it goes, in the words of the insert notice', () => {
      expect(buildApprovalMessage(t, 'Allow?', notePath, { ...insert, alias: 'rerun' })).toBe(
        `Allow?\n\nTarget: ${notePath}\n\nThis inserts unit operation [UHW010 Liquid Handling] rerun into ` +
          '001_WD010_Design.labnote.md (after the last unit operation).'
      );
      expect(buildApprovalMessage(t, 'Allow?', null, { ...insert, place: 'empty' })).toBe(
        'Allow?\n\nThis inserts unit operation [UHW010 Liquid Handling] into 001_WD010_Design.labnote.md.'
      );
      expect(buildApprovalMessage(t, 'Allow?', null, { ...insert, place: 'noSection', beforeConclusions: true })).toContain(
        '(before the conclusions: no unit operation section was found, so the table of contents was not updated).'
      );
    });

    it('says, as the app does, when the note has the same ID and alias', () => {
      const message = buildApprovalMessage(t, 'Allow?', notePath, { ...insert, sameAliasAs: '[UHW010 Liquid Handling]' });
      expect(message.split('\n').at(-1)).toBe(
        '[UHW010 Liquid Handling] is already in this note, so the two would read the same in the headings and the table of contents. Give this one its own alias to tell them apart.'
      );
      expect(erasesRecordedLines(insert)).toBe(false);
    });

    it('reads in Korean too', () => {
      expect(buildApprovalMessage(createObsidianTranslator('ko'), '허용?', null, insert)).toBe(
        '허용?\n\n유닛 오퍼레이션 [UHW010 Liquid Handling]을(를) 001_WD010_Design.labnote.md (마지막 유닛 오퍼레이션 다음)에 넣습니다.'
      );
    });
  });
});

describe('app additions', () => {
  const t = createObsidianTranslator('en');

  it('approval message keeps indented removed and added lines', () => {
    const preview = {
      kind: 'sectionEdit' as const,
      documentPath: 'a.labnote.md',
      heading: 'Results',
      parentHeading: '',
      occurrence: 1,
      total: 1,
      line: 3,
      removedLines: 1,
      removedSubheadings: 0,
      clearing: false,
      removedText: ['old'],
      removedMore: 0,
      addedText: ['new'],
      addedMore: 0,
    };
    const m = buildApprovalMessage(t, 'Allow?', 'a.labnote.md', preview);
    expect(m).toMatch(/\n {2,}old/);
    expect(m).toMatch(/\n {2,}new/);
    expect(erasesRecordedLines(preview)).toBe(true);
    expect(erasesRecordedLines({ ...preview, removedText: [] })).toBe(false);
    expect(erasesRecordedLines(undefined)).toBe(false);
    expect(erasesRecordedLines({ error: 'x' })).toBe(false);
  });

  it('every sentence it asks for has a Korean translation', () => {
    const preview = {
      kind: 'sectionEdit' as const,
      documentPath: 'a.labnote.md',
      heading: 'Results',
      parentHeading: '',
      occurrence: 2,
      total: 3,
      line: 3,
      removedLines: 1,
      removedSubheadings: 1,
      clearing: false,
      removedText: ['old'],
      removedMore: 2,
      addedText: ['new'],
      addedMore: 1,
    };
    const ko = createObsidianTranslator('ko');
    const m = buildApprovalMessage(ko, '허용?', 'a.labnote.md', preview);
    expect(m).not.toMatch(/Target:|This replaces|Lines removed|Lines added|nested heading|occurrence|more line/);
  });
});
