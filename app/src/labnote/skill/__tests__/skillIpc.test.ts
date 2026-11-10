import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fakeInvoke } from '../../../integrations/__tests__/fakeNet';
import { SKILL_ERROR_KINDS, SkillError, skillInstall, skillSaveAs, skillStatus, toSkillError } from '../skillIpc';

describe('skillIpc', () => {
  it('SKILL_ERROR_KINDS lists exactly the kinds Rust serializes', () => {
    const pinned = JSON.parse(readFileSync('src-tauri/tests/ipc-skill-errors.json', 'utf-8')) as Record<string, string>;
    expect([...SKILL_ERROR_KINDS].sort()).toEqual(Object.values(pinned).sort());
  });

  it('skillStatus calls skill_status with no arguments', async () => {
    const st = { target: 'C:\\Users\\u\\.claude\\skills\\labnoteo\\SKILL.md', exists: true, same: false };
    const f = fakeInvoke({ skill_status: () => st });
    expect(await skillStatus(f.invoke)).toEqual(st);
    expect(f.calls).toEqual([['skill_status', {}]]);
  });

  it('skillInstall sends only the overwrite flag, never content or a path', async () => {
    const f = fakeInvoke({ skill_install: () => ({ written: true }) });
    expect(await skillInstall(false, f.invoke)).toEqual({ written: true });
    expect(await skillInstall(true, f.invoke)).toEqual({ written: true });
    expect(f.calls).toEqual([
      ['skill_install', { overwrite: false }],
      ['skill_install', { overwrite: true }],
    ]);
  });

  it('skillSaveAs sends no arguments and gives the saved path or null on cancel', async () => {
    let picked: string | null = 'D:\\out\\SKILL.md';
    const f = fakeInvoke({ skill_save_as: () => picked });
    expect(await skillSaveAs(f.invoke)).toBe('D:\\out\\SKILL.md');
    picked = null;
    expect(await skillSaveAs(f.invoke)).toBeNull();
    expect(f.calls).toEqual([
      ['skill_save_as', {}],
      ['skill_save_as', {}],
    ]);
  });

  it('a Rust rejection becomes a SkillError with its kind', async () => {
    for (const kind of SKILL_ERROR_KINDS) {
      const f = fakeInvoke({
        skill_install: () => {
          throw { kind, message: 'raw' };
        },
      });
      const err = await skillInstall(false, f.invoke).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillError);
      expect(err).toMatchObject({ kind, message: 'raw' });
    }
  });

  it('an unknown or malformed rejection is io', () => {
    expect(toSkillError({ kind: 'mystery', message: 'm' }).kind).toBe('io');
    expect(toSkillError('plain')).toMatchObject({ kind: 'io', message: 'plain' });
    expect(toSkillError(null).kind).toBe('io');
    const e = new SkillError('exists', 'x');
    expect(toSkillError(e)).toBe(e);
  });
});
