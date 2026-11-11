/**
 * 도우미의 읽기 전용 partbank 도구(design §2.1–2.3): `partbank_search_parts`, `partbank_lookup_part`,
 * `partbank_list_groups`. 모두 Rust `partbank_read`(읽기 전용 허용 목록, 기본 연결)만 부른다: 쓰기 경로인
 * `partbank_request` 는 쓰지 않는다. 결과는 짧은 줄과 웹 페이지 링크이고, 서열은 검색 줄에 넣지 않는다.
 * 이 파일은 네트워크를 직접 쓰지 않는다: 부르는 일은 `LabIpc` 가 한다.
 */
import type { JsonSchema, ToolDef } from '@labnoteo/core';
import type { Source } from '../assistant/sources';
import { t } from '../i18n/t';
import { toNetError } from '../integrations/netIpc';
import {
  badArgs,
  DESC_SUFFIX,
  labTool,
  LabToolError,
  LAB_QUERY_MAX,
  modelText,
  onlyKeys,
  optEnum,
  optEnumList,
  optLimit,
  optString,
  reqString,
  type LabRunState,
} from './common';
import type { LabIpc, QueryPairs } from './ipc';
import { OID, PB_TYPES, partbankGroupLink, partbankItemLink, type PbScope, type PbType } from './links';
import { clip, compact, firstStr, fitRows, isRecord, listOf, num, records, str } from './shape';

export const PARTBANK_TOOL_NAMES = ['partbank_search_parts', 'partbank_lookup_part', 'partbank_list_groups'] as const;

/** 항목이 어디의 것인지, 지금 언어로: 내 것 / 그룹(이름) / 공개. 모르면 빈 글. 각 `t` 는 글자로 적는다(번역 목록 검사). */
export function scopeWord(scope: PbScope | undefined, group?: string | null): string {
  switch (scope) {
    case 'mine':
      return t('lab.pb.scope.mine');
    case 'group':
      return group ? t('lab.pb.scope.groupNamed', group) : t('lab.pb.scope.group');
    case 'public':
      return t('lab.pb.scope.public');
    default:
      return '';
  }
}

/** 검색 줄 설명의 최대 글자 수. */
export const PB_ROW_DESC_MAX = 160;
/** 항목 보기 설명의 최대 글자 수. */
export const PB_DETAIL_DESC_MAX = 600;
/** 항목 보기 서열의 최대 글자 수(프라이머는 늘 전부). */
export const PB_SEQUENCE_MAX = 3000;
const GROUPS_MAX = 50;

type Where = 'all' | 'mine' | 'group' | 'public';
const WHERE: readonly Where[] = ['all', 'mine', 'group', 'public'];
const INCLUDE = ['stock', 'usedIn', 'notes'] as const;
type Include = (typeof INCLUDE)[number];
const KID = /^[A-Za-z0-9_.-]{2,40}$/;

export interface PartbankToolOpts {
  ipc: LabIpc;
  /** 링크의 origin(웹 연결). 데스크톱 연결이면 null(링크 없음). */
  origin: string | null;
  state: LabRunState;
  /** 출처 장부(번호를 준다; 받을 수 없으면 0). */
  cite?: (src: Source) => number;
}

interface Group {
  groupId: string;
  name: string;
}

interface SearchRow extends Record<string, unknown> {
  id: string;
  kid?: string;
  type: PbType;
  subtype?: string;
  name?: string;
  scope: PbScope;
  group?: string | null;
  owner?: string;
  length?: number;
  description?: string;
  link: string | null;
  cite?: number;
}

const SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: LAB_QUERY_MAX, description: 'Name, KID or description words. Never put note text in it.' },
    where: { type: 'string', enum: [...WHERE], default: 'all' },
    types: { type: 'array', maxItems: 3, items: { type: 'string', enum: [...PB_TYPES] } },
    groupId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
    limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
  },
  required: ['query'],
};

const LOOKUP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...PB_TYPES] },
    id: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
    kid: { type: 'string', pattern: '^[A-Za-z0-9_.-]{2,40}$' },
    include: { type: 'array', maxItems: 3, items: { type: 'string', enum: [...INCLUDE] } },
  },
  required: ['type'],
};

const GROUPS_SCHEMA: JsonSchema = { type: 'object', properties: {} };

/** 서버의 형식 낱말을 도구의 형식으로(`vector` 는 plasmid). 모르면 undefined. */
function pbTypeOf(v: unknown): PbType | undefined {
  const s = str(v)?.toLowerCase();
  if (s === 'vector') return 'plasmid';
  if (s === 'construct') return 'device';
  return (PB_TYPES as readonly string[]).includes(s ?? '') ? (s as PbType) : undefined;
}

/** 상세·목록 경로의 조각(plasmid 는 devices). */
function detailSegment(type: PbType): string {
  return type === 'plasmid' ? 'devices' : `${type}s`;
}

function registryType(type: PbType): string {
  return type === 'plasmid' ? 'device' : type;
}

function ownerOf(o: Record<string, unknown>): string | undefined {
  const owner = isRecord(o.owner) ? firstStr(o.owner, 'username', 'name') : str(o.owner);
  return clip(firstStr(o, 'owner_username', 'owner_name', 'username') ?? owner, 60);
}

function lengthOf(o: Record<string, unknown>): number | undefined {
  return num(o.total_length) ?? num(o.length) ?? (typeof o.sequence === 'string' ? o.sequence.length : undefined);
}

/** 이 실행의 partbank 도구 세 개. 한도와 그룹 목록 캐시는 이 묶음 안에 있다: 실행마다 새로 만든다. */
export function partbankTools(o: PartbankToolOpts): ToolDef[] {
  const { ipc, origin, state } = o;
  let groupsCache: Group[] | undefined;

  const get = async (path: string, query?: QueryPairs): Promise<unknown> => (await ipc.partbankRead('GET', path, query)).json;

  const groups = async (): Promise<Group[]> => {
    if (groupsCache) return groupsCache;
    const json = await get('/groups/', [['limit', '100']]);
    groupsCache = listOf(json, 'groups')
      .map((g) => ({ groupId: firstStr(g, 'id', '_id') ?? '', name: clip(firstStr(g, 'name'), 80) ?? '' }))
      .filter((g) => OID.test(g.groupId));
    return groupsCache;
  };
  const groupName = async (gid: string | undefined): Promise<string | null> => {
    if (!gid) return null;
    try {
      return (await groups()).find((g) => g.groupId === gid)?.name ?? null;
    } catch (e) {
      if (toNetError(e).kind === 'cancelled') throw e;
      return null;
    }
  };

  /** 출처 칩의 이름표: 어디의 것인지(내 것 / 그룹 이름 / 공개)를 앞에 둔다. 모르면 빼고. */
  const addCite = (
    kid: string | undefined,
    name: string | undefined,
    link: string | null,
    scope: PbScope | undefined,
    group: string | null | undefined
  ) => {
    if (!link || !o.cite) return undefined;
    const where = scopeWord(scope, group);
    const label = `partbank${where ? ` (${where})` : ''}: ${[kid, name].filter(Boolean).join(' ') || 'item'}`;
    const n = o.cite({ kind: 'web', label, target: link });
    return n || undefined;
  };

  const toRow = (item: Record<string, unknown>, type: PbType, scope: PbScope, groupId: string | undefined, group: string | null): SearchRow | undefined => {
    const id = firstStr(item, 'id', '_id');
    if (!id || !OID.test(id)) return undefined;
    const subtype = firstStr(item, 'subtype', 'part_type', 'device_type', 'type');
    const kid = clip(firstStr(item, 'kid'), 40);
    const name = clip(firstStr(item, 'name'), 120);
    const link = partbankItemLink(origin, type, id, scope, groupId);
    const row: SearchRow = compact({
      id,
      kid,
      type,
      subtype: subtype && subtype.toLowerCase() !== type && pbTypeOf(subtype) === undefined ? clip(subtype, 40) : undefined,
      name,
      scope,
      group: scope === 'group' ? group : null,
      owner: ownerOf(item),
      length: lengthOf(item),
      description: clip(item.description, PB_ROW_DESC_MAX),
      link,
    });
    const n = addCite(kid, name, link, scope, group);
    if (n) row.cite = n;
    return row;
  };

  /** 형식 하나의 목록 경로와 쿼리(design §2.1 표). */
  const listCall = (where: Exclude<Where, 'all'>, type: PbType, query: string, limit: number, gid?: string): [string, QueryPairs] => {
    const common: QueryPairs = [
      ['search', query],
      ['limit', String(limit)],
    ];
    if (where === 'mine') {
      if (type === 'device' || type === 'plasmid') {
        return [
          '/devices/constructs',
          [
            ['scope', 'mine'],
            ['exclude_library_members', 'true'],
            ['include_components', 'false'],
            ...(type === 'plasmid' ? ([['type', 'plasmid']] as QueryPairs) : []),
            ...common,
          ],
        ];
      }
      return [`/workspace/${type}s`, [['scope', 'mine'], ...common, ...(type === 'part' ? ([['skip', '0']] as QueryPairs) : [])]];
    }
    if (where === 'group') {
      const seg = type === 'device' || type === 'plasmid' ? 'constructs' : `${type}s`;
      return [`/groups/${gid}/${seg}`, [...(type === 'plasmid' ? ([['type', 'plasmid']] as QueryPairs) : []), ...common]];
    }
    return [`/registry/${registryType(type)}`, [...(type === 'plasmid' ? ([['type', 'plasmid']] as QueryPairs) : []), ...common]];
  };

  const searchParts = labTool(
    {
      name: 'partbank_search_parts',
      description:
        "Search the lab's partbank (parts, devices/plasmids, primers, strains, molecules) by name, KID or description. " +
        "where: mine = the user's workspace, group = one group's shared items (needs groupId from partbank_list_groups), " +
        'public = the public registry, all = everything the user can read. Returns ids for partbank_lookup_part and links to ' +
        `the partbank web page.${DESC_SUFFIX}`,
      inputSchema: SEARCH_SCHEMA,
      check: (args) => {
        onlyKeys(args, ['query', 'where', 'types', 'groupId', 'limit']);
        return {
          query: reqString(args, 'query'),
          where: optEnum(args, 'where', WHERE, 'all'),
          types: optEnumList(args, 'types', PB_TYPES, 3),
          groupId: optString(args, 'groupId', OID),
          limit: optLimit(args),
        };
      },
      run: async (a: { query: string; where: Where; types?: PbType[]; groupId?: string; limit: number }) => {
        if (a.where === 'all') {
          const body = { query: a.query, limit: a.limit, ...(a.types ? { types: a.types } : {}) };
          const json = (await ipc.partbankRead('POST', '/search/global', undefined, body)).json;
          const hits = listOf(json, 'results');
          const rows: SearchRow[] = [];
          for (const h of hits) {
            const type = pbTypeOf(h.type) ?? pbTypeOf(h.resource_type) ?? 'part';
            const gid = str(h.group_id);
            const scope: PbScope = h.owner_is_me ? 'mine' : gid ? 'group' : 'public';
            const row = toRow(h, type, scope, gid, scope === 'group' ? await groupName(gid) : null);
            if (row) rows.push(row);
          }
          const shown = rows.slice(0, a.limit);
          const total = isRecord(json) ? (num(json.total) ?? hits.length) : hits.length;
          return fitRows(compact({ where: a.where, query: a.query, total, shown: shown.length, rows: shown, more: moreText(total, shown.length) }), 'rows');
        }
        let gid = a.groupId;
        let group: string | null = null;
        if (a.where === 'group') {
          const list = await groups();
          if (!gid) {
            if (list.length === 1) gid = list[0].groupId;
            else if (list.length === 0) throw new LabToolError('notFound', 'The user is in no partbank group.');
            else {
              const names = list.slice(0, 10).map((g) => `${g.name || '?'} (${g.groupId})`).join('; ');
              throw new LabToolError('needsGroup', `Several groups: ${names}. Ask the user which one, or call partbank_list_groups.`);
            }
          }
          group = list.find((g) => g.groupId === gid)?.name ?? null;
        }
        const types = a.types ?? ['part', 'device'];
        let total = 0;
        const rows: SearchRow[] = [];
        for (const type of types) {
          const [path, query] = listCall(a.where, type, a.query, a.limit, gid);
          const json = await get(path, query);
          let items = listOf(json);
          // VERIFY (c): when the registry ignores type=plasmid, keep only the plasmids it marks.
          if (type === 'plasmid' && a.where === 'public') items = items.filter((x) => x.is_plasmid !== false);
          total += isRecord(json) ? (num(json.total) ?? items.length) : items.length;
          for (const item of items) {
            const row = toRow(item, type, a.where, gid, group);
            if (row) rows.push(row);
          }
        }
        const shown = rows.slice(0, a.limit);
        return fitRows(
          compact({ where: a.where, query: a.query, ...(a.where === 'group' ? { group, groupId: gid } : {}), total, shown: shown.length, rows: shown, more: moreText(total, shown.length) }),
          'rows'
        );
      },
    },
    state
  );

  const lookupPart = labTool(
    {
      name: 'partbank_lookup_part',
      description:
        'Details of one partbank item by id (24 hex, from partbank_search_parts) or KID (e.g. KBp_aa0406). include adds stock ' +
        `locations, the devices that use it, or labnoteO notes that reference it.${DESC_SUFFIX}`,
      inputSchema: LOOKUP_SCHEMA,
      check: (args) => {
        onlyKeys(args, ['type', 'id', 'kid', 'include']);
        const type = optEnum<PbType | ''>(args, 'type', PB_TYPES, '');
        if (!type) throw badArgs('"type" is required.');
        const id = optString(args, 'id', OID);
        const kid = optString(args, 'kid', KID, 40);
        if ((id ? 1 : 0) + (kid ? 1 : 0) !== 1) throw badArgs('Give exactly one of "id" and "kid".');
        return { type, id, kid, include: optEnumList(args, 'include', INCLUDE, 3) ?? [] };
      },
      run: async (a: { type: PbType; id?: string; kid?: string; include: Include[] }) => {
        let id = a.id;
        let scope: PbScope | undefined;
        let gid: string | undefined;
        if (!id) {
          const json = (await ipc.partbankRead('POST', '/search/global', undefined, { query: a.kid, limit: 10, types: [a.type] })).json;
          const want = a.kid!.toLowerCase();
          const hit = listOf(json, 'results').find((h) => str(h.kid)?.toLowerCase() === want && OID.test(firstStr(h, 'id', '_id') ?? ''));
          if (!hit) throw new LabToolError('notFound', modelText('partbank', 'notFound'));
          id = firstStr(hit, 'id', '_id')!;
          gid = str(hit.group_id);
          scope = hit.owner_is_me ? 'mine' : gid ? 'group' : 'public';
        }
        let detail: unknown;
        try {
          detail = await get(`/${detailSegment(a.type)}/${id}`);
        } catch (e) {
          const err = toNetError(e);
          if (err.kind !== 'status' || (err.status !== 403 && err.status !== 404)) throw err;
          // VERIFY (d): a public item someone else owns may only be readable through the registry.
          detail = await get(`/registry/${registryType(a.type)}/${id}`);
          scope = 'public';
        }
        const item = isRecord(detail) && isRecord(detail.item) ? detail.item : isRecord(detail) ? detail : {};
        if (!scope && item.owner_is_me === true) scope = 'mine';
        const out = shapeDetail(item, a.type, id, scope, origin, gid);
        const group = scope === 'group' ? await groupName(gid) : null;
        if (scope === 'group' && group) out.group = group;
        const n = addCite(out.kid as string | undefined, out.name as string | undefined, out.link as string | null, scope, group);
        if (n) out.cite = n;
        for (const inc of a.include) {
          if (inc === 'stock') out.stock = shapeStock(await get(`/stock-box/by-resource/${a.type}/${id}`));
          if (inc === 'usedIn' && a.type !== 'primer' && a.type !== 'strain' && a.type !== 'molecule') {
            out.usedIn = shapeUsedIn(await get(`/reverse-lookup/${a.type}s/${id}/used-in`));
          }
          if (inc === 'notes') out.notes = shapeNotes(await get(`/labnoteo/usages/${a.type}/${id}`));
        }
        return out;
      },
    },
    state
  );

  const listGroups = labTool(
    {
      name: 'partbank_list_groups',
      description: `The user's partbank groups, with the groupId that partbank_search_parts needs for where "group".${DESC_SUFFIX}`,
      inputSchema: GROUPS_SCHEMA,
      check: (args) => {
        onlyKeys(args, []);
        return {};
      },
      run: async () => {
        const list = await groups();
        return {
          groups: list.slice(0, GROUPS_MAX).map((g) => ({ groupId: g.groupId, name: g.name, link: partbankGroupLink(origin, g.groupId) })),
          ...(list.length > GROUPS_MAX ? { more: `${list.length - GROUPS_MAX} more groups not shown` } : {}),
        };
      },
    },
    state
  );

  return [searchParts, lookupPart, listGroups];
}

function moreText(total: number, shown: number): string | undefined {
  return total > shown ? `${total - shown} more; narrow the query or ask the user to open the partbank page` : undefined;
}

/** 항목 보기(design §2.2 결과 칸). */
export function shapeDetail(
  item: Record<string, unknown>,
  type: PbType,
  id: string,
  scope: PbScope | undefined,
  origin: string | null,
  groupId?: string
): Record<string, unknown> {
  const subtype = firstStr(item, 'subtype', 'part_type', 'device_type', 'type');
  const verification = isRecord(item.verification) ? firstStr(item.verification, 'status', 'state', 'result') : str(item.verification);
  const tags = Array.isArray(item.tags) ? item.tags.map((x) => clip(x, 40)).filter((x): x is string => !!x).slice(0, 10) : undefined;
  const out: Record<string, unknown> = compact({
    id,
    kid: clip(firstStr(item, 'kid'), 40),
    type,
    subtype: subtype && subtype.toLowerCase() !== type ? clip(subtype, 40) : undefined,
    name: clip(firstStr(item, 'name'), 160),
    description: clip(item.description, PB_DETAIL_DESC_MAX),
    tags: tags?.length ? tags : undefined,
    owner: ownerOf(item),
    scope,
    sharing: clip(firstStr(item, 'sharing_level', 'sharing'), 40),
    verification: clip(verification, 60),
    createdAt: clip(item.created_at, 40),
    updatedAt: clip(item.updated_at, 40),
    link: partbankItemLink(origin, type, id, scope, groupId),
  });
  if (type === 'device' || type === 'plasmid') {
    const circular = typeof item.is_circular === 'boolean' ? item.is_circular : typeof item.circular === 'boolean' ? item.circular : str(item.topology) ? item.topology === 'circular' : undefined;
    if (circular !== undefined) out.circular = circular;
    const total = num(item.total_length);
    if (total !== undefined) out.totalLength = total;
    const comps = records(item.components);
    if (comps.length) {
      out.components = comps.slice(0, 30).map((c, i) => {
        const inner = isRecord(c.part) ? c.part : isRecord(c.sub_device) ? c.sub_device : isRecord(c.device) ? c.device : undefined;
        return compact({
          order: num(c.order) ?? num(c.position) ?? num(c.index) ?? i + 1,
          kind: clip(firstStr(c, 'component_type', 'kind', 'role') ?? (isRecord(c.sub_device) ? 'device' : 'part'), 40),
          name: clip(firstStr(inner, 'name') ?? firstStr(c, 'name'), 120),
          kid: clip(firstStr(inner, 'kid') ?? firstStr(c, 'kid'), 40),
          id: firstStr(inner, 'id', '_id') ?? firstStr(c, 'part_id', 'sub_device_id', 'device_id', 'id'),
        });
      });
      if (comps.length > 30) out.componentsMore = `${comps.length - 30} more components`;
    }
  }
  const seq = firstStr(item, 'sequence', 'full_sequence');
  if (seq) {
    const clean = seq.replace(/\s+/g, '');
    const max = type === 'primer' ? Infinity : PB_SEQUENCE_MAX;
    out.sequence = clean.length > max ? clean.slice(0, max) : clean;
    out.sequenceLength = clean.length;
    out.sequenceClipped = clean.length > max;
  }
  if (type === 'strain') {
    const species = clip(firstStr(item, 'species', 'organism'), 120);
    if (species) out.species = species;
    const genotype = clip(firstStr(item, 'genotype'), 400);
    if (genotype) out.genotype = genotype;
  }
  return out;
}

function shapeStock(json: unknown): Array<Record<string, unknown>> {
  return listOf(json, 'stocks', 'locations', 'samples')
    .slice(0, 10)
    .map((s) => {
      const box = isRecord(s.box) ? firstStr(s.box, 'name', 'label') : undefined;
      return compact({
        box: clip(box ?? firstStr(s, 'box_name', 'stock_box_name', 'box'), 80),
        position: clip(firstStr(s, 'position', 'well', 'slot', 'location'), 40),
        storage: clip(firstStr(s, 'storage', 'storage_location', 'freezer', 'temperature'), 80),
      });
    });
}

function shapeUsedIn(json: unknown): Array<Record<string, unknown>> {
  if (!isRecord(json)) return [];
  const pick = (v: unknown) => (Array.isArray(v) ? records(v) : listOf(v));
  return [...pick(json.parent_devices), ...pick(json.vectors)]
    .slice(0, 10)
    .map((d) => compact({ id: firstStr(d, 'id', '_id'), kid: clip(firstStr(d, 'kid'), 40), name: clip(firstStr(d, 'name'), 120) }));
}

function shapeNotes(json: unknown): Array<Record<string, unknown>> {
  return listOf(json)
    .slice(0, 10)
    .map((n) => compact({ notePath: clip(firstStr(n, 'note_path'), 300), title: clip(firstStr(n, 'note_title'), 120) }))
    .filter((n) => n.notePath);
}
