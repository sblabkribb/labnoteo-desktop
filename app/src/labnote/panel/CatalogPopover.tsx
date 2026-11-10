import { useId } from 'react';
import type { UnitOperationItem, WorkflowItem } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { coreT } from '../i18n';
import { catalogDescription } from '../port/aliasHints';
import { Popover } from '../../ui/Popover';

/** 카탈로그 항목 하나: 워크플로, 또는 HW/SW 유닛 오퍼레이션. */
export type CatalogEntry =
  | { kind: 'workflow'; item: WorkflowItem }
  | { kind: 'uo'; item: UnitOperationItem; opType: 'hw' | 'sw' };

/** 주 동작의 대상: 단추에 보일 이름(`003 · 대장균 숙주 비교`, `WB030 Gibson run`)과 할 일. */
export interface CatalogTarget {
  label: string;
  run: () => void;
}

/**
 * 실험 탭 카탈로그 항목의 작은 창(UI 재설계 Task 11): 코드, 영어 이름, 설명(한국어 화면이면 한국어와 영어), 장비·소프트웨어,
 * 그리고 주 동작 하나. 워크플로는 "현재 실험에 추가 (003 · …)", UO 는 "현재 워크플로에 삽입 (WB030 …)".
 * 대상이 없으면(실험·워크플로 노트가 열려 있지 않다) 단추는 꺼지고 까닭을 보인다. 카탈로그 이름은 영어 그대로다.
 */
export function CatalogPopover(p: {
  anchor: HTMLElement;
  entry: CatalogEntry;
  target?: CatalogTarget;
  /** 화면 언어(코어 locale): 한국어면 번역된 설명을 먼저 보인다. */
  locale: string;
  onClose: (opts: { restoreFocus: boolean }) => void;
}) {
  const reasonId = useId();
  const { entry, target } = p;
  const { id, name, description } = entry.item;
  const translated = description ? catalogDescription(id, description, p.locale) : '';
  const isWorkflow = entry.kind === 'workflow';
  const kindLabel = isWorkflow ? entry.item.category : entry.opType === 'hw' ? t('catalog.hw') : t('catalog.sw');
  const tool = entry.kind === 'uo' ? (entry.item.equipment ? [coreT('Equipment'), entry.item.equipment] : entry.item.software ? [coreT('Software'), entry.item.software] : undefined) : undefined;
  const action = isWorkflow
    ? target
      ? t('catalog.addToExperiment', target.label)
      : t('catalog.addToExperimentNone')
    : target
      ? t('catalog.insertIntoWorkflow', target.label)
      : t('catalog.insertIntoWorkflowNone');
  const reason = isWorkflow ? t('catalog.needExperiment') : t('catalog.needWorkflow');
  return (
    <Popover anchor={p.anchor} label={`${id} ${name}`} onClose={p.onClose} placement="right" className="catalog-popover">
      <div className="catalog-popover-head">
        <span className="picker-code">{id}</span>
        <strong className="catalog-popover-name">{name}</strong>
        {kindLabel ? <span className="catalog-popover-kind">{kindLabel}</span> : null}
      </div>
      {translated && translated !== description ? <p className="catalog-popover-desc">{translated}</p> : null}
      {description ? (
        <p className="catalog-popover-desc" lang="en">
          {description}
        </p>
      ) : null}
      {tool ? (
        <p className="catalog-popover-tool">
          {tool[0]}: {tool[1]}
        </p>
      ) : null}
      <div className="catalog-popover-actions">
        <button
          type="button"
          className="primary"
          disabled={!target}
          aria-describedby={target ? undefined : reasonId}
          onClick={() => {
            if (!target) return;
            p.onClose({ restoreFocus: false });
            target.run();
          }}
        >
          {action}
        </button>
        {target ? null : (
          <p id={reasonId} className="catalog-popover-reason">
            {reason}
          </p>
        )}
      </div>
    </Popover>
  );
}
