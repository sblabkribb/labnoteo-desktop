// Turns a bfworkflow service design (GET /api/services/{id}/current-design) into the
// React-Flow payload that the note generator reads (POST .../generate-notes).
// The server splits that payload by workflow group and classifies edges only by
// child-node membership, so every emitted edge joins two UO children; group-to-group
// edges are never emitted. Positions are all zero: the server does not read them.
// note_markdown is never copied into the payload.

export interface FlowNode {
  id: string;
  type: 'workflowGroup' | 'uoHardware' | 'uoSoftware';
  parentId?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface SavedNote {
  groupNodeId: string;
  workflowId: string;
  workflowName: string;
  markdown: string;
}

/** Edge ids the bfworkflow canvas creates by itself between two workflows; treated as unanchored. */
export const AUTO_EDGE_PREFIX = 'auto-';

const GROUP_PREFIX = 'wf-group-';
const NOTES_NODE_ID = 'pipeline-notes';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function serviceNodes(design: unknown): Record<string, unknown>[] {
  return isRecord(design) ? records(design.nodes) : [];
}

function snapshotOf(node: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(node.data) ? node.data : {};
  return isRecord(data.snapshot) ? data.snapshot : {};
}

function isNoteNode(node: Record<string, unknown>): boolean {
  return isRecord(node.data) && node.data.kind === 'note';
}

interface Group {
  id: string;
  /** Child node ids in snapshot order. */
  children: string[];
  /** Snapshot-local node id → child node id. */
  childBySnapshotId: Map<string, string>;
  first?: string;
  last?: string;
}

export function serviceDesignToFlow(design: unknown): { designType: 'service'; nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const groups = new Map<string, Group>(); // service node id → group

  const addEdge = (id: string, source: string, target: string) => {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;
    let unique = id;
    for (let n = 2; edgeIds.has(unique); n++) unique = `${id}~${n}`;
    edgeIds.add(unique);
    edges.push({ id: unique, source, target });
  };

  for (const sn of serviceNodes(design)) {
    const nodeId = str(sn.id);
    if (!nodeId || isNoteNode(sn) || groups.has(nodeId)) continue;
    const groupId = `${GROUP_PREFIX}${nodeId}`;
    if (nodeIds.has(groupId)) continue;
    const catalogId = str(sn.catalog_id);
    nodes.push({
      id: groupId,
      type: 'workflowGroup',
      position: { x: 0, y: 0 },
      data: {
        catalogId,
        workflowId: catalogId ?? (typeof sn.workflow_id === 'string' ? sn.workflow_id : ''),
        workflowName: typeof sn.catalog_name === 'string' ? sn.catalog_name : '',
        domain: typeof sn.domain === 'string' ? sn.domain : '',
        description: '',
      },
    });
    nodeIds.add(groupId);
    const group: Group = { id: groupId, children: [], childBySnapshotId: new Map() };
    groups.set(nodeId, group);

    const snapshot = snapshotOf(sn);
    for (const child of records(snapshot.nodes)) {
      const localId = str(child.id);
      const type = child.type === 'uo_hardware' ? 'uoHardware' : child.type === 'uo_software' ? 'uoSoftware' : undefined;
      if (!localId || !type || group.childBySnapshotId.has(localId)) continue;
      const childId = `${groupId}__${localId}`;
      if (nodeIds.has(childId)) continue;
      const d = isRecord(child.data) ? child.data : {};
      nodes.push({
        id: childId,
        type,
        parentId: groupId,
        position: { x: 0, y: 0 },
        data: {
          uoId: child.uo_id,
          label: child.label,
          uoName: child.uo_name,
          catalogId: child.catalog_id,
          input: d.input,
          output: d.output,
          equipment: d.equipment,
          method_hint: d.method_hint,
        },
      });
      nodeIds.add(childId);
      group.children.push(childId);
      group.childBySnapshotId.set(localId, childId);
    }

    const hasIn = new Set<string>();
    const hasOut = new Set<string>();
    for (const se of records(snapshot.edges)) {
      const source = group.childBySnapshotId.get(str(se.source) ?? '');
      const target = group.childBySnapshotId.get(str(se.target) ?? '');
      if (!source || !target) continue;
      addEdge(`${groupId}__${str(se.id) ?? `${se.source}-${se.target}`}`, source, target);
      hasOut.add(source);
      hasIn.add(target);
    }
    // "last UO → first UO": first is the first source, last the last sink, in snapshot order.
    group.first = group.children.find((c) => !hasIn.has(c)) ?? group.children[0];
    group.last = [...group.children].reverse().find((c) => !hasOut.has(c)) ?? group.children[group.children.length - 1];
  }

  const serviceEdges = isRecord(design) ? records(design.edges) : [];
  for (const se of serviceEdges) {
    const from = groups.get(str(se.source) ?? '');
    const to = groups.get(str(se.target) ?? '');
    if (!from || !to) continue;
    const id = str(se.id) ?? `${from.id}-${to.id}`;
    const sourceUo = str(se.source_uo_id);
    const targetUo = str(se.target_uo_id);
    const anchoredSource = sourceUo ? from.childBySnapshotId.get(sourceUo) : undefined;
    const anchoredTarget = targetUo ? to.childBySnapshotId.get(targetUo) : undefined;
    if (!id.startsWith(AUTO_EDGE_PREFIX) && anchoredSource && anchoredTarget) {
      addEdge(id, anchoredSource, anchoredTarget);
    } else if (from.last && to.first) {
      addEdge(id, from.last, to.first);
    }
  }

  return { designType: 'service', nodes, edges };
}

/** The workflow notes the server saved on the design's `pipeline-notes` node; empty markdown is left out. */
export function savedNotes(design: unknown): SavedNote[] {
  const notesNode = serviceNodes(design).find((n) => n.id === NOTES_NODE_ID);
  if (!notesNode) return [];
  const out: SavedNote[] = [];
  for (const n of records(snapshotOf(notesNode).workflow_notes)) {
    if (typeof n.markdown !== 'string' || n.markdown.trim() === '') continue;
    out.push({
      groupNodeId: typeof n.group_node_id === 'string' ? n.group_node_id : '',
      workflowId: typeof n.workflow_id === 'string' ? n.workflow_id : '',
      workflowName: typeof n.workflow_name === 'string' ? n.workflow_name : '',
      markdown: n.markdown,
    });
  }
  return out;
}

/** The `catalog_id` of the service node behind `wf-group-<id>` (or the bare node id). */
export function groupCatalogId(design: unknown, groupNodeId: string): string | undefined {
  const nodeId = groupNodeId.startsWith(GROUP_PREFIX) ? groupNodeId.slice(GROUP_PREFIX.length) : groupNodeId;
  const node = serviceNodes(design).find((n) => n.id === nodeId && !isNoteNode(n));
  return node ? str(node.catalog_id) : undefined;
}
