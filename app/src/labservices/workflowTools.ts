/**
 * 도우미의 읽기 전용 Workflow 서버 도구(design §2.4–2.7): `workflow_list_designs`, `workflow_get_design`,
 * `workflow_get_protocol_notes`, `workflow_get_method`. 모두 Rust `bfw_request`(GET 만, 허용 목록)로 읽는다. 노트 만들기
 * 스트림(`bfw_generate_notes`)이나 `/api/ai/*` 는 부르지 않는다.
 *
 * - 디자인 그래프는 `designToFlow.ts` 의 파서(`serviceDesignToFlow`, `savedNotes`)로 읽는다: 두 번째 파서를 쓰지 않는다.
 * - `/api/services` 는 서버에 검색이 없어 통째로 받고 TS 에서 거른다. 실행 안에서, 그리고 보관함·연결마다 5분 동안
 *   기억한다. 키가 바뀌면(`onSecretsChange`) 지운다.
 * - `workflow_get_method` 는 서버의 논문 지식 베이스다: 우리 실험실의 프로토콜이 아니다(결과에 그렇게 적는다).
 * 이 파일은 네트워크를 직접 쓰지 않는다: 부르는 일은 `LabIpc` 가 한다.
 */
import type { JsonSchema, ToolDef } from '@labnoteo/core';
import type { Source } from '../assistant/sources';
import { savedNotes, serviceDesignToFlow } from '../bfworkflow/designToFlow';
import { onSecretsChange } from '../integrations/secretsEvents';
import {
  DESC_SUFFIX,
  labTool,
  LabToolError,
  onlyKeys,
  optBool,
  optEnum,
  optEnumList,
  optLimit,
  optString,
  reqString,
  type LabRunState,
} from './common';
import type { LabIpc } from './ipc';
import { BFW_ID, designLink, designWorkflowLink, methodLink, noteLink, UO_CODE, WF_CODE } from './links';
import { clip, clipBlock, compact, firstStr, fitRows, isRecord, joinList, listOf, num, records, str } from './shape';

export const WORKFLOW_TOOL_NAMES = ['workflow_list_designs', 'workflow_get_design', 'workflow_get_protocol_notes', 'workflow_get_method'] as const;

/** `/api/services` 를 기억하는 시간. */
export const DESIGN_LIST_TTL_MS = 5 * 60 * 1000;
const TEXT_MAX = 200;
const NOTE_MAX = 2000;
const NOTES_TOTAL_MAX = 8000;
const NOTE_BODY_MAX = 8000;
const UO_FIELD_MAX = 800;
const UO_RESULT_MAX = 6000;
export const PAPER_NOTICE = "Summaries mined from published papers by the Workflow server; not the lab's own protocol. Say so when you use them.";

const ACCESS = ['any', 'owner', 'shared'] as const;
const METHOD_INCLUDE = ['papers', 'resources'] as const;

const listCache = new Map<string, { at: number; list: unknown }>();
let unsubscribe: (() => void) | undefined;

/** 기억한 디자인 목록을 지운다(설정·키가 바뀔 때, 테스트). */
export function clearDesignListCache(): void {
  listCache.clear();
}

function watchSecrets(): void {
  if (unsubscribe) return;
  unsubscribe = onSecretsChange(() => clearDesignListCache());
}

export interface WorkflowToolOpts {
  ipc: LabIpc;
  /** 링크의 origin(서버 연결). 데스크톱 연결이면 null. */
  origin: string | null;
  state: LabRunState;
  /** 5분 캐시의 열쇠: 보관함과 연결(주소). 없으면 실행 안에서만 기억한다. */
  cacheKey?: string;
  cite?: (src: Source) => number;
  /** 테스트가 시간을 정할 때만. */
  now?: () => number;
}

const LIST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200, description: 'Words matched against the name, code and description.' },
    access: { type: 'string', enum: [...ACCESS], default: 'any' },
    includeArchived: { type: 'boolean', default: false },
    limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
  },
};

const DESIGN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    serviceId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    includeNotes: { type: 'boolean', default: false },
  },
  required: ['serviceId'],
};

const NOTES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    serviceWorkflowId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    noteId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  },
  required: ['serviceWorkflowId'],
};

const METHOD_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    workflowId: { type: 'string', pattern: '^W[A-Z]{1,3}[0-9]{2,4}$' },
    uoId: { type: 'string', pattern: '^U[A-Z]{1,3}[0-9]{2,4}$' },
    include: { type: 'array', maxItems: 2, items: { type: 'string', enum: [...METHOD_INCLUDE] } },
  },
  required: ['workflowId'],
};

const time = (v: unknown): number => {
  const n = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** 이 실행의 Workflow 서버 도구 네 개. 한도와 실행 캐시는 이 묶음 안에 있다: 실행마다 새로 만든다. */
export function workflowTools(o: WorkflowToolOpts): ToolDef[] {
  const { ipc, origin, state } = o;
  const now = o.now ?? Date.now;
  const runCache = new Map<string, unknown>();
  watchSecrets();

  const cite = (label: string, link: string | null): number | undefined => {
    if (!link || !o.cite) return undefined;
    return o.cite({ kind: 'web', label, target: link }) || undefined;
  };

  const designList = async (archived: boolean): Promise<unknown> => {
    const key = `services|${archived}`;
    if (runCache.has(key)) return runCache.get(key);
    const longKey = o.cacheKey ? `${o.cacheKey}|${key}` : undefined;
    const hit = longKey ? listCache.get(longKey) : undefined;
    if (hit && now() - hit.at < DESIGN_LIST_TTL_MS) {
      runCache.set(key, hit.list);
      return hit.list;
    }
    const list = await ipc.bfwRead('/api/services', [['include_archived', archived ? 'true' : 'false']]);
    runCache.set(key, list);
    if (longKey) listCache.set(longKey, { at: now(), list });
    return list;
  };

  const listDesigns = labTool(
    {
      name: 'workflow_list_designs',
      description:
        "List the user's Workflow server designs (services): their own and ones shared with them. query filters by name, code " +
        `or description. Use workflow_get_design for one design.${DESC_SUFFIX}`,
      inputSchema: LIST_SCHEMA,
      check: (args) => {
        onlyKeys(args, ['query', 'access', 'includeArchived', 'limit']);
        return {
          query: optString(args, 'query'),
          access: optEnum(args, 'access', ACCESS, 'any'),
          includeArchived: optBool(args, 'includeArchived'),
          limit: optLimit(args),
        };
      },
      run: async (a: { query?: string; access: (typeof ACCESS)[number]; includeArchived: boolean; limit: number }) => {
        const words = (a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const all = listOf(await designList(a.includeArchived), 'services')
          .filter((s) => s.hidden_for_me !== true)
          .filter((s) => a.includeArchived || s.archived !== true)
          .filter((s) => {
            const level = str(s.access_level) ?? 'owner';
            return a.access === 'any' || (a.access === 'owner' ? level === 'owner' : level !== 'owner');
          })
          .filter((s) => {
            if (!words.length) return true;
            const hay = [s.name, s.code, s.description].map((x) => (typeof x === 'string' ? x.toLowerCase() : '')).join(' ');
            return words.every((w) => hay.includes(w));
          })
          .sort((x, y) => time(y.updated_at) - time(x.updated_at));
        const rows = all
          .filter((s) => BFW_ID.test(str(s.id) ?? ''))
          .slice(0, a.limit)
          .map((s) =>
            compact({
              serviceId: str(s.id)!,
              code: clip(s.code, 40),
              name: clip(s.name, 120),
              description: clip(s.description, 160),
              access: clip(s.access_level, 10) ?? 'owner',
              owner: clip(s.owner_name, 60),
              version: num(s.current_version_number),
              hasDraft: s.has_draft === true,
              workflowCount: num(s.workflow_count),
              uoCount: num(s.uo_count),
              updatedAt: clip(s.updated_at, 40),
              archived: s.archived === true,
              link: designLink(origin, str(s.id)!),
            })
          );
        return fitRows(
          compact({
            total: all.length,
            shown: rows.length,
            rows,
            more: all.length > rows.length ? `${all.length - rows.length} more; narrow the query` : undefined,
          }),
          'rows'
        );
      },
    },
    state
  );

  const getDesign = labTool(
    {
      name: 'workflow_get_design',
      description:
        'One Workflow server design: its Workflows (catalog code and name), the Unit Operations in each (input, output, ' +
        `equipment, method hint), how they connect, and the titles of saved Workflow notes.${DESC_SUFFIX}`,
      inputSchema: DESIGN_SCHEMA,
      check: (args) => {
        onlyKeys(args, ['serviceId', 'includeNotes']);
        return { serviceId: reqString(args, 'serviceId', BFW_ID, 64), includeNotes: optBool(args, 'includeNotes') };
      },
      run: async (a: { serviceId: string; includeNotes: boolean }) => {
        const sid = a.serviceId;
        const head = await ipc.bfwRead(`/api/services/${sid}`);
        const design = await ipc.bfwRead(`/api/services/${sid}/current-design`);
        const swList = listOf(await ipc.bfwRead(`/api/services/${sid}/workflows`), 'workflows');
        const service = isRecord(head) && isRecord(head.service) ? head.service : isRecord(head) ? head : {};
        const versions = isRecord(head) ? records(head.versions) : [];
        const link = designLink(origin, sid);

        const serviceWorkflows = swList
          .filter((w) => BFW_ID.test(str(w.id) ?? ''))
          .slice(0, 20)
          .map((w) =>
            compact({
              serviceWorkflowId: str(w.id)!,
              catalogId: clip(firstStr(w, 'catalog_id'), 20),
              name: clip(firstStr(w, 'name'), 120),
              link: designWorkflowLink(origin, sid, str(w.id)!),
            })
          );
        const byCatalog = (catalogId: string | undefined, name: string | undefined) => {
          const same = catalogId ? serviceWorkflows.filter((w) => w.catalogId === catalogId) : [];
          if (same.length === 1) return same[0];
          const named = name ? serviceWorkflows.filter((w) => w.name === name) : [];
          return named.length === 1 ? named[0] : undefined;
        };

        const flow = serviceDesignToFlow(design);
        const uoOf = new Map<string, string>();
        const groups = flow.nodes.filter((n) => n.type === 'workflowGroup');
        const workflows = groups.slice(0, 20).map((g) => {
          const catalogId = clip(g.data.catalogId, 20);
          const name = clip(g.data.workflowName, 120);
          const sw = byCatalog(catalogId, name);
          const children = flow.nodes.filter((n) => n.parentId === g.id);
          for (const c of children) uoOf.set(c.id, clip(c.data.uoId, 20) ?? clip(c.data.label, 40) ?? '?');
          return compact({
            catalogId,
            name,
            domain: clip(g.data.domain, 40),
            serviceWorkflowId: sw?.serviceWorkflowId,
            link: sw?.link,
            unitOperations: children.slice(0, 25).map((c) =>
              compact({
                uoId: clip(c.data.uoId, 20),
                name: clip(c.data.uoName, TEXT_MAX),
                label: clip(c.data.label, TEXT_MAX),
                kind: c.type === 'uoSoftware' ? 'software' : 'hardware',
                input: joinList(c.data.input, TEXT_MAX),
                output: joinList(c.data.output, TEXT_MAX),
                equipment: joinList(c.data.equipment, TEXT_MAX),
                methodHint: joinList(c.data.method_hint, TEXT_MAX),
              })
            ),
            ...(children.length > 25 ? { unitOperationsMore: `${children.length - 25} more` } : {}),
          });
        });
        for (const g of groups.slice(20)) for (const c of flow.nodes.filter((n) => n.parentId === g.id)) uoOf.set(c.id, clip(c.data.uoId, 20) ?? '?');
        const edges = flow.edges.slice(0, 60).map((e) => `${uoOf.get(e.source) ?? '?'} -> ${uoOf.get(e.target) ?? '?'}`);

        let budget = NOTES_TOTAL_MAX;
        const notes = savedNotes(design).map((n) => {
          const row: Record<string, unknown> = compact({
            workflowId: clip(n.workflowId, 40),
            workflowName: clip(n.workflowName, 120),
            chars: n.markdown.length,
          });
          if (a.includeNotes && budget > 0) {
            const body = clipBlock(n.markdown, Math.min(NOTE_MAX, budget));
            budget -= body.text.length;
            row.markdown = body.text;
            if (body.clipped) row.clipped = true;
          }
          return row;
        });

        const out = compact({
          serviceId: sid,
          code: clip(service.code, 40),
          name: clip(service.name, 160),
          description: clip(service.description, 300),
          access: clip(service.access_level, 10),
          owner: clip(service.owner_name, 60),
          archived: service.archived === true ? true : undefined,
          versions: versions.slice(-3).map((v) =>
            compact({
              version: num(v.version_number),
              status: clip(v.status, 20),
              changeNote: clip(v.change_note, 160),
              createdAt: clip(v.created_at, 40),
              actor: clip(v.actor_name, 60),
            })
          ),
          link,
          cite: cite(`Workflow server: ${clip(service.name, 120) ?? sid}`, link),
          workflows,
          ...(groups.length > 20 ? { workflowsMore: `${groups.length - 20} more Workflows` } : {}),
          serviceWorkflows,
          edges,
          notes,
        });
        return fitRows(fitRows(out, 'notes'), 'workflows');
      },
    },
    state
  );

  const getNotes = labTool(
    {
      name: 'workflow_get_protocol_notes',
      description: `Protocol notes saved under one Workflow of a design. Without noteId: the list. With noteId: that note's markdown.${DESC_SUFFIX}`,
      inputSchema: NOTES_SCHEMA,
      check: (args) => {
        onlyKeys(args, ['serviceWorkflowId', 'noteId']);
        return { serviceWorkflowId: reqString(args, 'serviceWorkflowId', BFW_ID, 64), noteId: optString(args, 'noteId', BFW_ID, 64) };
      },
      run: async (a: { serviceWorkflowId: string; noteId?: string }) => {
        const wid = a.serviceWorkflowId;
        const sw = await ipc.bfwRead(`/api/service-workflows/${wid}`);
        const wf = isRecord(sw) && isRecord(sw.workflow) ? sw.workflow : isRecord(sw) ? sw : {};
        const sid = firstStr(wf, 'service_id');
        const workflowName = clip(wf.name, 120);
        if (!a.noteId) {
          const list = listOf(await ipc.bfwRead(`/api/service-workflows/${wid}/notes`), 'notes');
          const rows = list
            .filter((n) => BFW_ID.test(str(n.id) ?? ''))
            .slice(0, 30)
            .map((n) =>
              compact({
                noteId: str(n.id)!,
                name: clip(n.name, 160),
                updatedAt: clip(n.updated_at, 40),
                link: sid ? noteLink(origin, sid, wid, str(n.id)!) : null,
              })
            );
          return fitRows(compact({ serviceWorkflowId: wid, workflowName, total: list.length, notes: rows }), 'notes');
        }
        const json = await ipc.bfwRead(`/api/notes/${a.noteId}`);
        const note = isRecord(json) && isRecord(json.note) ? json.note : isRecord(json) ? json : {};
        if (!str(note.markdown) && !str(note.name)) throw new LabToolError('notFound', 'Not found in the Workflow server. Check the id; list the notes first.');
        const body = clipBlock(note.markdown, NOTE_BODY_MAX);
        const link = sid ? noteLink(origin, sid, wid, a.noteId) : null;
        return compact({
          noteId: a.noteId,
          name: clip(note.name, 160),
          version: num(note.version) ?? num(note.version_number),
          workflowName,
          link,
          cite: cite(`Workflow note: ${clip(note.name, 120) ?? a.noteId}`, link),
          markdown: body.text,
          clipped: body.clipped,
        });
      },
    },
    state
  );

  const getMethod = labTool(
    {
      name: 'workflow_get_method',
      description:
        "What published papers say about a catalog Workflow (from the Workflow server's paper knowledge base). Without uoId: its " +
        'hardware/software Unit Operations, their order and QC checkpoints. With uoId: that Unit Operation\'s input, output, ' +
        'equipment, consumables, method, parameters and environment. include papers lists the source papers. Use search_catalog ' +
        `first to get the codes.${DESC_SUFFIX}`,
      inputSchema: METHOD_SCHEMA,
      check: (args) => {
        onlyKeys(args, ['workflowId', 'uoId', 'include']);
        return {
          workflowId: reqString(args, 'workflowId', WF_CODE, 8),
          uoId: optString(args, 'uoId', UO_CODE, 8),
          include: optEnumList(args, 'include', METHOD_INCLUDE, 2) ?? [],
        };
      },
      run: async (a: { workflowId: string; uoId?: string; include: Array<(typeof METHOD_INCLUDE)[number]> }) => {
        const wf = a.workflowId;
        const link = methodLink(origin, wf);
        let out: Record<string, unknown>;
        if (!a.uoId) {
          const d = await ipc.bfwRead(`/api/workflows/${wf}`);
          const w = isRecord(d) ? d : {};
          const uos = (v: unknown) =>
            (Array.isArray(v) ? v : [])
              .map((u) => (isRecord(u) ? compact({ uoId: clip(firstStr(u, 'uo_id', 'id'), 20), name: clip(firstStr(u, 'name', 'uo_name'), 120) }) : { uoId: clip(u, 20) }))
              .filter((u) => u.uoId || (u as Record<string, unknown>).name)
              .slice(0, 30);
          out = compact({
            workflowId: wf,
            name: clip(w.name, 160),
            domain: clip(w.domain, 40),
            description: clip(w.description, 400),
            hardwareUos: uos(w.hardware_uos),
            softwareUos: uos(w.software_uos),
            connections: records(w.uo_connections)
              .slice(0, 40)
              .map((c) => {
                const obj = clip(firstStr(c, 'transfer_object'), 80);
                return `${clip(firstStr(c, 'from_uo'), 20) ?? '?'} -> ${clip(firstStr(c, 'to_uo'), 20) ?? '?'}${obj ? ` (${obj})` : ''}`;
              }),
            qcCheckpoints: (Array.isArray(w.qc_checkpoints) ? w.qc_checkpoints : []).slice(0, 10).map((q) =>
              isRecord(q)
                ? compact({
                    afterUo: clip(firstStr(q, 'after_uo'), 20),
                    check: clip(firstStr(q, 'check', 'checkpoint', 'name', 'description', 'criteria'), 200),
                    onFail: clip(firstStr(q, 'action_on_fail'), 160),
                  })
                : { check: clip(q, 200) }
            ),
          });
        } else {
          const d = await ipc.bfwRead(`/api/workflows/${wf}/uo/${a.uoId}`);
          const u = isRecord(d) ? d : {};
          const field = (v: unknown, max: number) => joinList(v, max);
          const build = (max: number) =>
            compact({
              workflowId: wf,
              uoId: a.uoId,
              type: clip(u.type, 20),
              input: field(u.input, max),
              output: field(u.output, max),
              equipment: field(u.equipment, max),
              consumables: field(u.consumables, max),
              method: field(u.material_and_method ?? u.method, max),
              parameters: field(u.parameters, max),
              environment: field(u.environment, max),
              result: field(u.result, max),
              discussion: field(u.discussion, max),
            });
          out = build(UO_FIELD_MAX);
          for (let max = UO_FIELD_MAX; JSON.stringify(out).length > UO_RESULT_MAX && max > 100; max = Math.floor(max * 0.7)) out = build(max);
        }
        if (a.include.includes('papers')) {
          const p = await ipc.bfwRead(`/api/workflows/${wf}/papers`);
          const papers = listOf(p, 'papers').map((x) => ({ title: clip(firstStr(x, 'title'), 200), verdict: clip(firstStr(x, 'panel_verdict', 'verdict'), 20) }));
          const accepted = (v?: string) => (v && /^accept/i.test(v) ? 0 : 1);
          out.papers = papers
            .filter((x) => x.title)
            .sort((x, y) => accepted(x.verdict) - accepted(y.verdict))
            .slice(0, 10)
            .map((x) => compact(x));
        }
        if (a.include.includes('resources')) {
          const r = await ipc.bfwRead(`/api/workflows/${wf}/resources`);
          const names = (v: unknown) =>
            [...new Set((Array.isArray(v) ? v : []).map((x) => clip(isRecord(x) ? firstStr(x, 'name', 'equipment', 'tool') : x, 80)).filter((x): x is string => !!x))].slice(0, 15);
          out.resources = isRecord(r) ? { equipment: names(r.equipment_uses), tools: names(r.tool_uses) } : { equipment: [], tools: [] };
        }
        out.link = link;
        const n = cite(`Workflow papers: ${wf}${a.uoId ? ` ${a.uoId}` : ''}`, link);
        if (n) out.cite = n;
        out.source = PAPER_NOTICE;
        return out;
      },
    },
    state
  );

  return [listDesigns, getDesign, getNotes, getMethod];
}
