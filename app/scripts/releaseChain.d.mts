// Types for releaseChain.mjs (hand-written; the script itself is plain Node ESM).

/** Repo-relative files that hold the six app-version sites. */
export const VERSION_FILES: readonly string[];

/** '0.1.9' -> '0.1.10'; throws on anything but x.y.z. */
export function bumpPatch(v: string): string;

/**
 * The six sites, keyed 'package.json', 'package-lock.json#version',
 * 'package-lock.json#packages[""]', 'tauri.conf.json', 'Cargo.toml', 'Cargo.lock#labnoteo-app'.
 */
export function readVersions(files: Record<string, string>): Record<string, string>;

/** A new file map with all six sites set to `v`; formatting and line endings are kept. */
export function setVersion(files: Record<string, string>, v: string): Record<string, string>;

/** The shared version, or throws listing every site when they differ. */
export function assertSameVersion(files: Record<string, string>): string;
