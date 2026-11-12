/**
 * 샘플 탭의 PartBank 구역이 그리는 줄(PartbankSection.tsx). Rust `partbank_read` 의 답(JSON)을 읽기만 하는 순수한 함수들:
 * - `pbPanelRows`: `POST /search/global` 의 `results` 를 줄로. 찾기 대상 이름은 링크가 적는 유형으로 바꾸고(vector → plasmid),
 *   유형을 모르거나 id 가 ObjectId 가 아닌 줄은 버린다(가져오기가 그 id 로 항목을 읽는다).
 *   범위는 비서 도구(labservices/partbankTools.ts)와 같다: owner_is_me 면 내 것, group_id 가 있으면 그룹, 아니면 공개.
 * - `pbGroupNames`: `GET /groups/` 의 답을 그룹 id → 이름으로.
 */
import { typeFromSearchEntity, type PartbankItem, type PartbankType } from '@labnoteo/core';
import type { PbScope } from '../labservices/links';

/** PartBank 의 id 는 Mongo ObjectId 다. */
const OID = /^[0-9a-f]{24}$/i;

/** 구역의 한 줄: 가져오기와 열기에 넘기는 항목(PartbankItem)에 범위와 그룹을 더한 것. */
export interface PbPanelRow extends PartbankItem {
  type: PartbankType;
  scope: PbScope;
  /** 그룹 범위의 그룹 id(이름은 pbGroupNames 로 찾는다). */
  groupId: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `POST /search/global` 의 답을 구역의 줄로. 모르는 꼴이면 빈 목록. */
export function pbPanelRows(json: unknown): PbPanelRow[] {
  const results = isRecord(json) ? json.results : undefined;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw): PbPanelRow[] => {
    if (!isRecord(raw)) return [];
    const entity = str(raw, 'type');
    const id = str(raw, 'id');
    const type = entity ? typeFromSearchEntity(entity) : undefined;
    if (!type || !id || !OID.test(id)) return [];
    const groupId = str(raw, 'group_id');
    const scope: PbScope = raw.owner_is_me === true ? 'mine' : groupId ? 'group' : 'public';
    return [
      {
        type,
        id,
        kid: str(raw, 'kid'),
        name: str(raw, 'name'),
        description: str(raw, 'description'),
        moleculeType: str(raw, 'molecule_type'),
        scope,
        groupId,
      },
    ];
  });
}

/** `GET /groups/` 의 답(`{ groups }`, `{ items }` 또는 목록)을 그룹 id → 이름으로. 이름 없는 그룹은 뺀다. */
export function pbGroupNames(json: unknown): Map<string, string> {
  const list = Array.isArray(json) ? json : isRecord(json) ? (Array.isArray(json.groups) ? json.groups : json.items) : undefined;
  const out = new Map<string, string>();
  if (!Array.isArray(list)) return out;
  for (const g of list) {
    if (!isRecord(g)) continue;
    const id = str(g, 'id') ?? str(g, '_id');
    const name = str(g, 'name');
    if (id && OID.test(id) && name) out.set(id, name.slice(0, 80));
  }
  return out;
}
