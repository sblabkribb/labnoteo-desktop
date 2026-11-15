// Rewrites the `allow-*` entries of src-tauri/capabilities/default.json from src-tauri/commands.txt.
// Every other entry and the description stay exactly as they are. The seven pet-only commands belong to
// pet.json, not to the main window. Run: node scripts/gen-capabilities.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const PET_ONLY = new Set(['pet_geometry', 'pet_set_layout', 'pet_hide', 'pet_open_main', 'pet_quiet_get', 'pet_quiet_set', 'pet_panel_size', 'pet_start_failed', 'pet_subscribe', 'pet_to_main']);
const commands = readFileSync(join(root, 'commands.txt'), 'utf-8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const file = join(root, 'capabilities', 'default.json');
const text = readFileSync(file, 'utf-8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const allow = commands.filter((c) => !PET_ONLY.has(c)).map((c) => `allow-${c.replace(/_/g, '-')}`);
// Text edit, not a JSON re-print, so the file's own layout and every other entry stay byte for byte: the generated
// names are the lines `"allow-..."` at the end of the (last) permissions array.
const end = text.lastIndexOf(']');
const head = text.slice(0, end).replace(/,\s*"allow-[a-z0-9-]+"/g, '').trimEnd();
const out = head + allow.map((a) => `,${eol}    "${a}"`).join('') + eol + '  ' + text.slice(end);
JSON.parse(out); // refuse to write anything that is not JSON
writeFileSync(file, out);
