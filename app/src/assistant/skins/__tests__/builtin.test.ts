import { existsSync, readFileSync } from 'node:fs';
import { BUILTIN_SKIN, BUILTIN_SKIN_ID, builtinSheetUrl } from '../builtin';
import { SKIN_STATES } from '../types';

const DIR = 'public/skins/flasko';

// PNG IHDR: width/height are big-endian u32 at byte offsets 16 and 20.
function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('built-in Flasko skin', () => {
  it('matches the committed manifest exactly', () => {
    const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, 'utf-8'));
    expect(manifest).toEqual(BUILTIN_SKIN);
    expect(BUILTIN_SKIN.id).toBe(BUILTIN_SKIN_ID);
    expect(BUILTIN_SKIN.licence).toBe('CC0-1.0');
  });

  it('declares all four states', () => {
    expect(Object.keys(BUILTIN_SKIN.states).sort()).toEqual([...SKIN_STATES].sort());
  });

  it('has a sheet file of the right size for every state', () => {
    for (const state of SKIN_STATES) {
      const s = BUILTIN_SKIN.states[state];
      const path = `${DIR}/${s.sheet}`;
      expect(existsSync(path)).toBe(true);
      expect(pngSize(path)).toEqual({
        width: BUILTIN_SKIN.frame.width * s.frames,
        height: BUILTIN_SKIN.frame.height,
      });
    }
  });

  it('serves sheets from the app origin (self), never blob/asset', () => {
    for (const state of SKIN_STATES) {
      expect(builtinSheetUrl(state)).toBe(`/skins/flasko/${state}.png`);
    }
  });
});
