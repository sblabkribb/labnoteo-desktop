/**
 * The saved context-window setting (`llmContextWindow`) as the settings field edits it:
 * a preset from `WINDOW_PRESETS` or a typed whole number, clamped to 2048–1,000,000.
 */
import { clampContextWindow } from '../settings';
import { WINDOW_PRESETS } from './sourcesModel';

export function isPresetWindow(n: number): boolean {
  return WINDOW_PRESETS.includes(n);
}

/**
 * A typed value: digits only (spaces around are ignored), then clamped into range.
 * Anything else (empty, a sign, a decimal, an exponent) is `null` and is not saved.
 */
export function parseWindowInput(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? clampContextWindow(n) : clampContextWindow(Number.MAX_SAFE_INTEGER);
}
