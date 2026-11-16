import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
const PET_ONLY = ['pet_geometry', 'pet_set_layout', 'pet_hide', 'pet_open_main', 'pet_quiet_get', 'pet_quiet_set', 'pet_panel_size', 'pet_start_failed', 'pet_subscribe', 'pet_to_main'];

describe('the pet window capability', () => {
  it('applies to the pet window only, and the main capability to the main window only', () => {
    expect(pet.windows).toEqual(['pet']);
    expect(main.windows).toEqual(['main']);
  });

  it('lists exactly what the pet needs', () => {
    expect(ids(pet).sort()).toEqual(
      ['core:window:allow-start-dragging', ...PET_ONLY.map(allow), 'allow-skin-read'].sort(),
    );
  });

  it('has no event permission at all: a listener on the global bus would receive every app-wide event (LLM frames, vault changes)', () => {
    for (const id of ids(pet)) expect(id, id).not.toMatch(/^core:event:/);
  });

  it('the pet page never imports the Tauri event api', () => {
    expect(read('src/pet/petIpc.ts')).not.toMatch(/api\/event/);
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

// Static guards (plan Task 9): the pet code must not be able to reach the vault, the network, git, scanning or settings.
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : files(p, ext);
    return ext.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}
const specifiers = (src: string): string[] =>
  // \x27 and \x22 are the two quote characters (kept out of the literal for the escapes guard)
  [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\x27\x22]*?\bfrom\s*[\x27\x22]([^\x27\x22]+)[\x27\x22]|(?:^|\n)\s*import\s*[\x27\x22]([^\x27\x22]+)[\x27\x22]/g)].map((m) => m[1] ?? m[2]);
const FORBIDDEN = /^(?:\.\.\/)+(?:fs|vault|integrations|github|labnote|partbank|bfworkflow|ai|labservices|links|search)(?:\/|$)/;

describe('static pet guards', () => {
  const petFiles = files('src/pet', /\.(?:ts|tsx)$/);

  it('finds the pet sources and parses their imports', () => {
    expect(petFiles.length).toBeGreaterThan(5);
    expect(specifiers("import { a } from '../x';\nimport '../y.css';")).toEqual(['../x', '../y.css']);
    expect('../integrations/netIpc').toMatch(FORBIDDEN);
    expect('../assistant/petStore').not.toMatch(FORBIDDEN);
  });

  it('no pet source imports the vault, fs, integrations, github, labnote, partbank, bfworkflow, ai, labservices, links or search code', () => {
    for (const f of petFiles) for (const s of specifiers(readFileSync(f, 'utf-8'))) expect(s, `${f} imports ${s}`).not.toMatch(FORBIDDEN);
  });

  it('PetApp imports only react, src/pet, the assistant panel, the skins, the pet store helpers and i18n', () => {
    const src = readFileSync('src/pet/PetApp.tsx', 'utf-8');
    const ok = /^(?:react|\.\/[A-Za-z]+|\.\.\/assistant\/Bubble|\.\.\/assistant\/skins\/[A-Za-z]+|\.\.\/assistant\/petStore|\.\.\/i18n\/[A-Za-z]+|\.\.\/ui\/Icon)$/;
    for (const s of specifiers(src)) expect(s, s).toMatch(ok);
    // from petStore: the sprite and layout helpers only, never the store itself
    const names = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*\x27\.\.\/assistant\/petStore\x27/g)].flatMap((m) => m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '')));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(['applySkinVars', 'BUBBLE_GAP', 'DRAG_THRESHOLD', 'snapScale'], n).toContain(n);
  });

  it('nothing the pet page loads at run time (followed through every import) is vault, fs, network, git or AI code', () => {
    // Type-only imports vanish at build time; every other import is followed from the page entry.
    const runtimeSpecifiers = (src: string): string[] =>
      [...src.matchAll(/(?:^|\n)\s*(import|export)\s+(?!type\b)[^;\x27\x22]*?\bfrom\s*[\x27\x22]([^\x27\x22]+)[\x27\x22]|(?:^|\n)\s*import\s*[\x27\x22]([^\x27\x22]+)[\x27\x22]/g)].map(
        (m) => m[2] ?? m[3],
      );
    const resolve = (from: string, spec: string): string | null => {
      if (!spec.startsWith('.')) return null; // a package
      const base = join(from, '..', spec);
      for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        try {
          if (statSync(p).isFile()) return p;
        } catch {
          /* try the next */
        }
      }
      return null;
    };
    const seen = new Set<string>();
    const todo = ['src/pet/main.tsx'];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f) || !/\.(?:ts|tsx)$/.test(f)) continue;
      seen.add(f);
      for (const s of runtimeSpecifiers(readFileSync(f, 'utf-8'))) {
        const r = resolve(f, s);
        if (r) todo.push(r);
      }
    }
    const reached = [...seen].map((p) => p.replace(/\\/g, '/'));
    expect(reached).toContain('src/assistant/Bubble.tsx');
    const bad = /^src\/(?:fs|vault|integrations|github|labnote|partbank|bfworkflow|ai|labservices|links|search|editor)\//;
    for (const p of reached) expect(p, p).not.toMatch(bad);
    for (const p of reached) expect(p, p).not.toMatch(/^src\/assistant\/(?:chips|builtinRuntime|wiring|useAssistantSession|sectionOptions|tools|compact|history)\.tsx?$/);
  });

  it('the pet Rust sources never mention the vault, net, git sync, scan, directory reads, secrets, process spawning or the opener', () => {
    const rust = files('src-tauri/src/pet', /\.rs$/);
    expect(rust.length).toBeGreaterThanOrEqual(4);
    const bad = /vault::|net::|gitsync|scan::|read_dir|secrets|Command::new|opener/;
    for (const f of rust) expect(readFileSync(f, 'utf-8'), f).not.toMatch(bad);
  });
});
