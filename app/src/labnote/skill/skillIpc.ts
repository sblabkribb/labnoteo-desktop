import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../../integrations/netIpc';

/**
 * Typed wrappers for the SKILL.md installer (src-tauri/src/skill.rs).
 * Rust writes only the embedded SKILL.md: these calls never send content or a path.
 * Install goes to `<home>/.claude/skills/labnoteo/SKILL.md`; Save as uses Rust's own dialog.
 * Copy needs no IPC: the webview already has the text (`SKILL_TEXT`, `copyText`).
 */

/** Rust `SkillErrorKind` (pinned in `src-tauri/tests/ipc-skill-errors.json`). */
export type SkillErrorKind = 'exists' | 'symlink' | 'noHome' | 'io';

export const SKILL_ERROR_KINDS: readonly SkillErrorKind[] = ['exists', 'symlink', 'noHome', 'io'];

export class SkillError extends Error {
  constructor(
    readonly kind: SkillErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

/** A Rust rejection `{kind, message}` as a `SkillError`; anything unknown is `io`. */
export function toSkillError(e: unknown): SkillError {
  if (e instanceof SkillError) return e;
  if (e && typeof e === 'object') {
    const o = e as { kind?: unknown; message?: unknown };
    const message = typeof o.message === 'string' ? o.message : String(e);
    const kind = SKILL_ERROR_KINDS.includes(o.kind as SkillErrorKind) ? (o.kind as SkillErrorKind) : 'io';
    return new SkillError(kind, message);
  }
  return new SkillError('io', String(e));
}

export interface SkillStatus {
  /** The install target, for display. */
  target: string;
  exists: boolean;
  /** True when the installed file is exactly the embedded SKILL.md. */
  same: boolean;
}

async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toSkillError(e);
  }
}

export function skillStatus(invoke: InvokeFn = tauriInvoke): Promise<SkillStatus> {
  return call<SkillStatus>(invoke, 'skill_status', {});
}

/** `written:false` when it is already up to date. A differing file needs `overwrite` (else `exists`). */
export function skillInstall(overwrite: boolean, invoke: InvokeFn = tauriInvoke): Promise<{ written: boolean }> {
  return call<{ written: boolean }>(invoke, 'skill_install', { overwrite });
}

/** The path written, or null when the user cancelled the dialog. */
export function skillSaveAs(invoke: InvokeFn = tauriInvoke): Promise<string | null> {
  return call<string | null>(invoke, 'skill_save_as', {});
}
