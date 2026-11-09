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

/** Key id of the placeholder updater pubkey committed before the real key exists. */
export const PLACEHOLDER_KEY_ID: 'F52F0A1D2C0B789E';

/** `plugins.updater.pubkey` (base64 of minisign text) -> key id, 16 upper-hex chars; throws if malformed. */
export function keyIdFromPubkey(pubkeyB64: string): string;

/** A tauri `.sig` (base64 of minisign signature text) -> key id; throws if malformed. */
export function keyIdFromSig(sigB64: string): string;

/** True when the pubkey's key id is the placeholder's; throws if malformed. */
export function isPlaceholderPubkey(pubkeyB64: string): boolean;

export type ReleaseDecision =
  | { action: 'none'; reason: string }
  | { action: 'bump' }
  | { action: 'retag'; tag: string };

/** The release decision table (B-R3, B-R4, B-R12); throws on a malformed tag or an empty core pointer. */
export function decideRelease(i: {
  ready: boolean;
  newestTag: string | null;
  coreAtMain: string;
  coreAtTag: string | null;
  tagReleased: boolean;
}): ReleaseDecision;

/**
 * Whether a GitHub Release (`gh release view <tag> --json isDraft,assets`) is fully uploaded: latest.json, the
 * `*_<version>_x64-setup.exe` installer and its `.sig`, each non-empty (and `uploaded` when a state is given).
 * 'complete' = published with all of them, 'draft' = all of them but still a draft, 'incomplete' = something is missing.
 * Throws on a malformed tag or release JSON.
 */
export function releaseState(
  release: { isDraft: boolean; assets: { name: string; size: number; state?: string }[] },
  tag: string,
): { state: 'complete' | 'draft' | 'incomplete'; missing: string[] };
