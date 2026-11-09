// Ported from app/vendor/labnoteo/src/scaffold/assets.ts:95-95 sha256:f43d661f134e4b1c
// Ported from app/vendor/labnoteo/src/scaffold/assets.ts:108-108 sha256:f30c6ec124c1d034
// Ported from app/vendor/labnoteo/src/scaffold/assets.ts:135-135 sha256:355b1a34877427ad
// Ported from app/vendor/labnoteo/src/scaffold/scaffold.ts:395-402 sha256:996d8f9d46a05b9e
// Ported from app/vendor/labnoteo/src/commands.ts:1052-1070 sha256:c4af1f6a018f77e1
// labnoteO 0.140.2, Apache-2.0.
// Changes: only these constants and functions; assets.ts and scaffold.ts import the bundled templates (dist-automation/), which the app does not have.
// Changes: `LABNOTEO_DIR` is not exported (only SETUP_DOC_PATH uses it here).
// Changes: `host: LabnoteHost` -> `host: Pick<LabnoteHost, 'fs'>` in all three functions.

import type { LabnoteHost } from '@labnoteo/core';

const LABNOTEO_DIR = '.labnoteo';

/** Vault path of the admin/developer setup guide, surfaced in the completion notice. */
export const SETUP_DOC_PATH = `${LABNOTEO_DIR}/SETUP.md`;

/**
 * Vault path of the workflow that opens Issues from `@issue` markers and the
 * `discuss` flag; its presence is how the commands tell automation is set up.
 */
export const ISSUE_SYNC_WORKFLOW_PATH = '.github/workflows/experiment-issues.yml';

/**
 * Whether the vault root is a git repository. The automation lives at the vault
 * root (`.github/`, `.labnoteo/`), so only a repository rooted there runs it.
 * `.git` may be a file (worktree) as well as a folder.
 */
export async function isVaultGitRepository(host: Pick<LabnoteHost, 'fs'>): Promise<boolean> {
  return host.fs.exists('.git');
}

/**
 * Whether this vault has the workflow that turns `@issue` markers and the
 * `discuss` flag into GitHub Issues. Without it both are inert, which the
 * commands must say instead of promising an issue on the next push. Whether
 * the vault is pushed with Actions enabled is beyond what the plugin can see.
 */
export async function isIssueAutomationInstalled(host: Pick<LabnoteHost, 'fs'>): Promise<boolean> {
  return host.fs.exists(ISSUE_SYNC_WORKFLOW_PATH);
}

/**
 * Whether an `@issue` marker or the `discuss` flag can become an issue:
 * `'none'` without the automation, `'no-git'` when it is installed but the
 * vault is not a git repository yet (nothing can be pushed), `'ready'` otherwise.
 */
export async function issueAutomationState(host: Pick<LabnoteHost, 'fs'>): Promise<'none' | 'no-git' | 'ready'> {
  if (!(await isIssueAutomationInstalled(host))) return 'none';
  return (await isVaultGitRepository(host)) ? 'ready' : 'no-git';
}
