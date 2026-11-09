import { describe, expect, it } from 'vitest';
import { AUTO_EDGE_PREFIX, groupCatalogId, savedNotes, serviceDesignToFlow } from '../designToFlow';

function uo(id: string, type = 'uo_hardware', extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    uo_id: type === 'uo_software' ? 'USW005' : 'UHW010',
    uo_name: `UO ${id}`,
    label: `Label ${id}`,
    catalog_id: type === 'uo_software' ? 'USW005' : 'UHW010',
    data: { input: 'in', output: 'out', equipment: 'Thermocycler', method_hint: 'hint', note_markdown: '# secret note body' },
    ...extra,
  };
}

function wf(id: string, snapNodes: unknown[], snapEdges: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id,
    workflow_id: 'WB030',
    catalog_name: `Workflow ${id}`,
    domain: 'build',
    catalog_id: 'WB030',
    data: { snapshot: { nodes: snapNodes, edges: snapEdges } },
    ...extra,
  };
}

const edge = (id: string, source: string, target: string) => ({ id, source, target });

function design(edges: unknown[]) {
  return {
    nodes: [
      wf('n1', [uo('s1'), uo('s2', 'uo_software')], [edge('e1', 's1', 's2')]),
      wf('n2', [uo('s1'), uo('s3')], [edge('e1', 's1', 's3')]),
    ],
    edges,
  };
}

const ends = (r: ReturnType<typeof serviceDesignToFlow>) => r.edges.map((e) => [e.source, e.target]);

describe('serviceDesignToFlow', () => {
  it('two workflows become two groups with children and a uo-anchored edge', () => {
    const r = serviceDesignToFlow(design([{ id: 'x1', source: 'n1', target: 'n2', source_uo_id: 's2', target_uo_id: 's1' }]));
    expect(r.designType).toBe('service');
    const groups = r.nodes.filter((n) => n.type === 'workflowGroup');
    expect(groups.map((g) => g.id)).toEqual(['wf-group-n1', 'wf-group-n2']);
    const kids = r.nodes.filter((n) => n.parentId === 'wf-group-n1');
    expect(kids.map((k) => [k.id, k.type])).toEqual([
      ['wf-group-n1__s1', 'uoHardware'],
      ['wf-group-n1__s2', 'uoSoftware'],
    ]);
    expect(kids[0].data).toEqual({
      uoId: 'UHW010', label: 'Label s1', uoName: 'UO s1', catalogId: 'UHW010',
      input: 'in', output: 'out', equipment: 'Thermocycler', method_hint: 'hint',
    });
    expect(r.nodes.every((n) => n.position.x === 0 && n.position.y === 0)).toBe(true);
    expect(ends(r)).toContainEqual(['wf-group-n1__s2', 'wf-group-n2__s1']);
    // the snapshot edges map to child ids
    expect(ends(r)).toContainEqual(['wf-group-n1__s1', 'wf-group-n1__s2']);
    expect(ends(r)).toContainEqual(['wf-group-n2__s1', 'wf-group-n2__s3']);
    expect(r.edges).toHaveLength(3);
  });

  it('an anchored edge joins exactly the named children, not last → first', () => {
    const r = serviceDesignToFlow(design([{ id: 'x1', source: 'n1', target: 'n2', source_uo_id: 's1', target_uo_id: 's3' }]));
    expect(ends(r)).toContainEqual(['wf-group-n1__s1', 'wf-group-n2__s3']);
    expect(ends(r)).not.toContainEqual(['wf-group-n1__s2', 'wf-group-n2__s1']);
  });

  it('an unanchored service edge joins the last UO of the source to the first UO of the target', () => {
    const r = serviceDesignToFlow(design([{ id: 'x1', source: 'n1', target: 'n2' }]));
    expect(ends(r)).toContainEqual(['wf-group-n1__s2', 'wf-group-n2__s1']);
    const groupIds = new Set(r.nodes.filter((n) => n.type === 'workflowGroup').map((n) => n.id));
    for (const e of r.edges) {
      expect(groupIds.has(e.source)).toBe(false);
      expect(groupIds.has(e.target)).toBe(false);
    }
  });

  it('last and first follow the snapshot edges, not the node order', () => {
    // snapshot order s3, s1, s2 with edges s1→s2→s3: first is s1, last is s3
    const d = {
      nodes: [
        wf('n1', [uo('s3'), uo('s1'), uo('s2')], [edge('a', 's1', 's2'), edge('b', 's2', 's3')]),
        wf('n2', [uo('t2'), uo('t1')], [edge('a', 't1', 't2')]),
      ],
      edges: [{ id: 'x', source: 'n1', target: 'n2' }],
    };
    expect(ends(serviceDesignToFlow(d))).toContainEqual(['wf-group-n1__s3', 'wf-group-n2__t1']);
  });

  it('an edge with the automatic inter-workflow prefix is treated as unanchored', () => {
    const r = serviceDesignToFlow(design([{ id: `${AUTO_EDGE_PREFIX}n1-n2`, source: 'n1', target: 'n2', source_uo_id: 's1', target_uo_id: 's3' }]));
    expect(ends(r)).toContainEqual(['wf-group-n1__s2', 'wf-group-n2__s1']);
    expect(ends(r)).not.toContainEqual(['wf-group-n1__s1', 'wf-group-n2__s3']);
  });

  it('an anchored edge whose UO ids are missing falls back to last → first', () => {
    const r = serviceDesignToFlow(design([{ id: 'x1', source: 'n1', target: 'n2', source_uo_id: 'UHW010', target_uo_id: 'gone' }]));
    expect(ends(r)).toContainEqual(['wf-group-n1__s2', 'wf-group-n2__s1']);
    expect(r.edges).toHaveLength(3);
  });

  it('an edge to a group without children is dropped', () => {
    const d = { nodes: [wf('n1', [uo('s1')], []), wf('n2', [], [])], edges: [{ id: 'x', source: 'n1', target: 'n2' }, { id: 'y', source: 'n2', target: 'n1' }] };
    const r = serviceDesignToFlow(d);
    expect(r.nodes.map((n) => n.id)).toEqual(['wf-group-n1', 'wf-group-n1__s1', 'wf-group-n2']);
    expect(r.edges).toEqual([]);
  });

  it('group data uses the catalog id when there is one', () => {
    const uuid = '5f0c2b1e-0000-4000-8000-000000000001';
    const d = {
      nodes: [
        wf('n1', [uo('s1')], [], { workflow_id: uuid, catalog_id: 'WB030' }),
        wf('n2', [uo('s1')], [], { workflow_id: uuid, catalog_id: null, catalog_name: 'Imported', domain: 'test' }),
      ],
      edges: [],
    };
    const [g1, , g2] = serviceDesignToFlow(d).nodes;
    expect(g1.data).toEqual({ catalogId: 'WB030', workflowId: 'WB030', workflowName: 'Workflow n1', domain: 'build', description: '' });
    expect(g2.id).toBe('wf-group-n2');
    expect(g2.data.workflowId).toBe(uuid);
    expect(g2.data.catalogId).toBeUndefined();
    expect(g2.data.workflowName).toBe('Imported');
  });

  it('note nodes are skipped and note_markdown is never sent', () => {
    const d = design([]);
    (d.nodes as unknown[]).push({ id: 'pipeline-notes', workflow_id: '', data: { kind: 'note', snapshot: { workflow_notes: [{ markdown: 'x' }] } } });
    (d.nodes[0].data.snapshot.nodes as unknown[]).push({ id: 'inner', type: 'workflowGroup', data: {} });
    const r = serviceDesignToFlow(d);
    expect(r.nodes.some((n) => n.id.includes('pipeline-notes'))).toBe(false);
    expect(r.nodes.some((n) => n.id.endsWith('__inner'))).toBe(false);
    expect(JSON.stringify(r)).not.toContain('note_markdown');
    expect(JSON.stringify(r)).not.toContain('secret note body');
  });

  it('an edge to a missing node is dropped', () => {
    const d = design([{ id: 'x1', source: 'n1', target: 'nope' }, { id: 'x2', source: 'ghost', target: 'n2', source_uo_id: 's1', target_uo_id: 's1' }]);
    (d.nodes[0].data.snapshot.edges as unknown[]).push(edge('bad', 's1', 'missing'));
    const r = serviceDesignToFlow(d);
    expect(r.edges).toHaveLength(2);
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const e of r.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it('edge ids are unique', () => {
    const r = serviceDesignToFlow(design([{ id: 'x', source: 'n1', target: 'n2' }, { id: 'x', source: 'n1', target: 'n2', source_uo_id: 's1', target_uo_id: 's3' }]));
    expect(new Set(r.edges.map((e) => e.id)).size).toBe(r.edges.length);
  });

  it('garbage input gives an empty design, not a throw', () => {
    expect(serviceDesignToFlow(null)).toEqual({ designType: 'service', nodes: [], edges: [] });
    for (const v of [undefined, 3, 'x', [], { nodes: 'x' }, { nodes: [null, 3, { id: 5 }, { id: 'n', data: { snapshot: { nodes: [null, { id: 3, type: 'uo_hardware' }] } } }], edges: [null, 'x'] }]) {
      expect(() => serviceDesignToFlow(v)).not.toThrow();
    }
  });
});

describe('savedNotes', () => {
  it('savedNotes reads pipeline-notes workflow_notes with markdown', () => {
    const d = {
      nodes: [
        wf('n1', [uo('s1')], []),
        { id: 'pipeline-notes', data: { kind: 'note', snapshot: { workflow_notes: [
          { group_node_id: 'wf-group-n1', workflow_id: 'WB030', workflow_name: 'PCR', markdown: '# PCR' },
          { group_node_id: 'wf-group-n2', workflow_id: '', workflow_name: 'Empty', markdown: '   ' },
          { group_node_id: 'wf-group-n3', workflow_id: '', workflow_name: 'Imported', markdown: '# Imported' },
          null,
          { markdown: 5 },
        ] } } },
      ],
      edges: [],
    };
    expect(savedNotes(d)).toEqual([
      { groupNodeId: 'wf-group-n1', workflowId: 'WB030', workflowName: 'PCR', markdown: '# PCR' },
      { groupNodeId: 'wf-group-n3', workflowId: '', workflowName: 'Imported', markdown: '# Imported' },
    ]);
  });

  it('no pipeline-notes node or garbage gives no notes', () => {
    expect(savedNotes(design([]))).toEqual([]);
    expect(savedNotes(null)).toEqual([]);
    expect(savedNotes({ nodes: [{ id: 'pipeline-notes', data: { snapshot: { workflow_notes: 'x' } } }] })).toEqual([]);
  });
});

describe('groupCatalogId', () => {
  it('returns the catalog id behind a group id or a bare node id', () => {
    const d = { nodes: [wf('n1', [], [], { catalog_id: 'WB030' }), wf('n2', [], [], { catalog_id: null })], edges: [] };
    expect(groupCatalogId(d, 'wf-group-n1')).toBe('WB030');
    expect(groupCatalogId(d, 'n1')).toBe('WB030');
    expect(groupCatalogId(d, 'wf-group-n2')).toBeUndefined();
    expect(groupCatalogId(d, 'wf-group-zz')).toBeUndefined();
    expect(groupCatalogId(null, 'n1')).toBeUndefined();
  });
});
