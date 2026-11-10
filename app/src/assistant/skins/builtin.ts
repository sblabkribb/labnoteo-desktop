import type { SkinManifest, SkinState } from './types';

/**
 * The built-in default skin "Flasko" (original art, CC0-1.0), drawn by
 * `app/scripts/art/draw_flasko.py` into `app/public/skins/flasko/`. Vite serves
 * `public/` at the app root, so the sheets load from 'self' (CSP img-src).
 * Kept identical to `public/skins/flasko/manifest.json` (tested).
 */
export const BUILTIN_SKIN_ID = 'flasko';

export const BUILTIN_SKIN: SkinManifest = {
  format: 1,
  id: BUILTIN_SKIN_ID,
  name: 'Flasko',
  author: 'labnoteO',
  licence: 'CC0-1.0',
  version: '1.0.0',
  description: 'A little round-bottom flask that helps with lab notes.',
  frame: { width: 32, height: 32 },
  states: {
    idle: { sheet: 'idle.png', frames: 4, fps: 4 },
    talk: { sheet: 'talk.png', frames: 4, fps: 8 },
    think: { sheet: 'think.png', frames: 6, fps: 6 },
    done: { sheet: 'done.png', frames: 6, fps: 10 },
  },
};

/** Same-origin URL of a built-in sprite sheet. */
export function builtinSheetUrl(state: SkinState): string {
  return `/skins/${BUILTIN_SKIN_ID}/${BUILTIN_SKIN.states[state].sheet}`;
}
