/**
 * The Samples tab's PartBank list rows (partbankRows.ts): `POST /search/global` rows as panel rows, and `GET /groups/` as
 * group names. Pure: no invoke, no feature.
 */
import { pbGroupNames, pbPanelRows } from '../partbankRows';

const OID = (n: number) => `665f1a2b3c4d5e6f7081${String(n).padStart(4, '0')}`;

describe('pbPanelRows', () => {
  it('maps a search entity to the type a link stores (vector → plasmid) and keeps the item fields', () => {
    const rows = pbPanelRows({
      results: [
        { type: 'vector', id: OID(1), kid: 'KV-00231', name: ' pET28a-sfGFP ', description: 'T7', molecule_type: 'DNA', owner_is_me: true },
        { type: 'part', id: OID(2), kid: 'KP-01102', name: 'sfGFP CDS', owner_is_me: true },
      ],
    });
    expect(rows).toEqual([
      { type: 'plasmid', id: OID(1), kid: 'KV-00231', name: 'pET28a-sfGFP', description: 'T7', moleculeType: 'DNA', scope: 'mine', groupId: null },
      { type: 'part', id: OID(2), kid: 'KP-01102', name: 'sfGFP CDS', description: null, moleculeType: null, scope: 'mine', groupId: null },
    ]);
  });

  it('owner_is_me is mine, a group_id is group, anything else is public', () => {
    const rows = pbPanelRows({
      results: [
        { type: 'part', id: OID(1), owner_is_me: true, group_id: 'g1' },
        { type: 'part', id: OID(2), owner_is_me: false, group_id: '665f00000000000000000a01' },
        { type: 'part', id: OID(3), sharing_level: 'public' },
        { type: 'part', id: OID(4), owner_is_me: 'yes' },
      ],
    });
    expect(rows.map((r) => [r.scope, r.groupId])).toEqual([
      ['mine', 'g1'],
      ['group', '665f00000000000000000a01'],
      ['public', null],
      ['public', null],
    ]);
  });

  it('drops rows with an unknown type or an id that is not an ObjectId, and any non-object answer', () => {
    expect(
      pbPanelRows({
        results: [
          { type: 'spaceship', id: OID(1) },
          { type: 'part', id: 'KP-01102' },
          { type: 'part' },
          null,
          'x',
          { type: 'primer', id: OID(5) },
        ],
      }).map((r) => r.id),
    ).toEqual([OID(5)]);
    expect(pbPanelRows(null)).toEqual([]);
    expect(pbPanelRows({ results: 'no' })).toEqual([]);
    expect(pbPanelRows([])).toEqual([]);
  });
});

describe('pbGroupNames', () => {
  it('reads { groups }, { items } or a bare list, keyed by ObjectId', () => {
    const g = '665f00000000000000000a01';
    expect(pbGroupNames({ groups: [{ id: g, name: '발현 팀' }] }).get(g)).toBe('발현 팀');
    expect(pbGroupNames({ items: [{ _id: g, name: 'Team' }] }).get(g)).toBe('Team');
    expect(pbGroupNames([{ id: g, name: 'T' }, { id: 'bad', name: 'x' }, { id: g.replace('1', '2') }]).size).toBe(1);
    expect(pbGroupNames('nope').size).toBe(0);
  });
});
