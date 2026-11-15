import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Cap = { identifier: string; windows: string[]; permissions: Array<string | { identifier: string }> };
const read = (p: string) => readFileSync(p, 'utf-8');
const pet = JSON.parse(read('src-tauri/capabilities/pet.json')) as Cap;
const main = JSON.parse(read('src-tauri/capabilities/default.json')) as Cap;
const ids = (c: Cap) => c.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
const commands = read('src-tauri/commands.txt').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
// register_commands! lists every command as `$crate::path::name,`
const lib = read('src-tauri/src/lib.rs');
const block = lib.split('generate_handler![')[1].split(']')[0];
const registered = [...block.matchAll(/\$crate::(?:[a-z0-9_]+::)*([a-z0-9_]+),/g)].map((m) => m[1]);
const allow = (c: string) => `allow-${c.replace(/_/g, '-')}`;
const PET_ONLY = ['pet_geometry', 'pet_set_layout', 'pet_hide', 'pet_open_main', 'pet_quiet_get', 'pet_quiet_set', 'pet_start_failed'];

describe('the pet window capability', () => {
  it('applies to the pet window only, and the main capability to the main window only', () => {
    expect(pet.windows).toEqual(['pet']);
    expect(main.windows).toEqual(['main']);
  });

  it('lists exactly what the pet needs', () => {
    expect(ids(pet).sort()).toEqual(
      ['core:event:allow-listen', 'core:event:allow-unlisten', 'core:event:allow-emit', 'core:window:allow-start-dragging', ...PET_ONLY.map(allow), 'allow-skin-read'].sort(),
    );
  });

  it('lists no vault, net, git, scan, settings, fs, dialog, opener, updater, process, mcp, index, secret or window-destroy permission', () => {
    const bad = /vault|net|github|gitsync|scan|setting|fs|file|dialog|opener|updater|process|mcp|index|secret|skill|print|shell|http|clipboard|core:default|core:window:default|destroy|close/i;
    for (const id of ids(pet)) expect(id, id).not.toMatch(bad);
  });

  it('the pet cannot start or close itself (those belong to the main window)', () => {
    expect(ids(pet)).not.toContain('allow-pet-start');
    expect(ids(pet)).not.toContain('allow-pet-close');
  });

  it('the parse of register_commands! sees every $crate path in the handler list', () => {
    expect(registered.length).toBe((block.match(/\$crate::/g) ?? []).length);
    expect(registered.length).toBeGreaterThan(100);
  });

  it('commands.txt and register_commands! list the same commands, each once', () => {
    expect(new Set(commands).size).toBe(commands.length);
    expect([...commands].sort()).toEqual([...registered].sort());
    for (const c of PET_ONLY) expect(commands).toContain(c);
  });

  it('the main capability grants every command except the pet-only ones, and nothing unknown', () => {
    const granted = new Set(ids(main).filter((i) => i.startsWith('allow-')));
    for (const c of commands) expect(granted.has(allow(c)), c).toBe(!PET_ONLY.includes(c));
    const known = new Set(commands.map(allow));
    for (const g of granted) expect(known.has(g), g).toBe(true);
  });
});
