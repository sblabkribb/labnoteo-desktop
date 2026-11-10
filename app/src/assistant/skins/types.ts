/** Skin pack manifest (spec §8.1). Validated in Rust (`skins/pack.rs`); this is the shape the webview reads. */

export const SKIN_STATES = ['idle', 'talk', 'think', 'done'] as const;
export type SkinState = (typeof SKIN_STATES)[number];

/** SPDX licence allowlist (spec §8.1). */
export const SKIN_LICENCES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'Apache-2.0', 'OFL-1.1'] as const;
export type SkinLicence = (typeof SKIN_LICENCES)[number];

export interface SkinStateSpec {
  /** Sheet file name inside the pack: one horizontal row of `frames` frames. */
  sheet: string;
  frames: number;
  fps: number;
}

export interface SkinManifest {
  format: 1;
  id: string;
  name: string;
  author: string;
  licence: SkinLicence;
  version: string;
  description?: string;
  frame: { width: number; height: number };
  states: Record<SkinState, SkinStateSpec>;
}
