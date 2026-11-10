// @vitest-environment jsdom
/**
 * The SKILL.md section of Integration settings (Task 17, spec §12). Rust is a fake `invoke`;
 * nothing here resolves a real home folder or writes a file.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NotifyKind } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { fakeInvoke } from '../../../integrations/__tests__/fakeNet';
import { styleAttributes } from '../../host/__tests__/harness';
import { SkillSection } from '../SkillSection';
import { SKILL_TEXT } from '../skillText';

const TARGET = 'C:/Users/tester/.claude/skills/labnoteo/SKILL.md';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

type Notes = Array<{ kind: NotifyKind; message: string }>;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => undefined);
}

function rust(state: { exists: boolean; same: boolean }, routes: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  return fakeInvoke({
    skill_status: () => ({ target: TARGET, ...state }),
    skill_install: () => {
      const written = !state.same;
      state.exists = true;
      state.same = true;
      return { written };
    },
    skill_save_as: () => 'D:/agents/SKILL.md',
    ...routes,
  });
}

async function mount(r: ReturnType<typeof rust>, copy?: (text: string) => Promise<void>) {
  const notes: Notes = [];
  render(<SkillSection notify={(kind, message) => notes.push({ kind, message })} invoke={r.invoke} copy={copy} />);
  await flush();
  return notes;
}

const cmds = (r: ReturnType<typeof rust>) => r.calls.map(([c]) => c);
const button = (name: string) => screen.getByRole('button', { name });

describe('SkillSection', () => {
  it('calls only skill_status on mount and shows the target and "not installed"', async () => {
    const r = rust({ exists: false, same: false });
    await mount(r);
    expect(cmds(r)).toEqual(['skill_status']);
    expect(screen.getByText(t('skill.target', TARGET))).toBeTruthy();
    expect(screen.getByText(t('skill.state.absent'))).toBeTruthy();
    expect(styleAttributes()).toEqual([]);
  });

  it('shows "differs" and "up to date"', async () => {
    const a = rust({ exists: true, same: false });
    await mount(a);
    expect(screen.getByText(t('skill.state.differs'))).toBeTruthy();
    cleanup();
    const b = rust({ exists: true, same: true });
    await mount(b);
    expect(screen.getByText(t('skill.state.same'))).toBeTruthy();
  });

  it('previews SKILL_TEXT read-only', async () => {
    await mount(rust({ exists: false, same: false }));
    const pre = document.querySelector('pre.skill-preview');
    expect(pre?.textContent).toBe(SKILL_TEXT);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('installs without overwrite when absent and refreshes the status', async () => {
    const r = rust({ exists: false, same: false });
    const notes = await mount(r);
    fireEvent.click(button(t('skill.install')));
    await flush();
    expect(r.calls.filter(([c]) => c === 'skill_install')).toEqual([['skill_install', { overwrite: false }]]);
    expect(notes).toEqual([{ kind: 'info', message: t('skill.installed', TARGET) }]);
    expect(screen.getByText(t('skill.state.same'))).toBeTruthy();
  });

  it('reports "already up to date" when nothing was written', async () => {
    const r = rust({ exists: true, same: true });
    const notes = await mount(r);
    fireEvent.click(button(t('skill.install')));
    await flush();
    expect(r.calls.filter(([c]) => c === 'skill_install')).toEqual([['skill_install', { overwrite: false }]]);
    expect(notes).toEqual([{ kind: 'info', message: t('skill.upToDate') }]);
  });

  it('asks before overwriting a differing file: Cancel calls nothing, confirming overwrites', async () => {
    const r = rust({ exists: true, same: false });
    await mount(r);
    fireEvent.click(button(t('skill.install')));
    await flush();
    expect(cmds(r)).toEqual(['skill_status']);
    expect(screen.getByText(t('skill.confirmOverwrite', TARGET))).toBeTruthy();
    fireEvent.click(button(t('skill.cancel')));
    await flush();
    expect(cmds(r)).toEqual(['skill_status']);
    expect(screen.queryByText(t('skill.confirmOverwrite', TARGET))).toBeNull();

    fireEvent.click(button(t('skill.install')));
    await flush();
    fireEvent.click(button(t('skill.overwrite')));
    await flush();
    expect(r.calls.filter(([c]) => c === 'skill_install')).toEqual([['skill_install', { overwrite: true }]]);
    expect(screen.getByText(t('skill.state.same'))).toBeTruthy();
  });

  for (const kind of ['exists', 'symlink', 'noHome', 'io'] as const) {
    for (const lang of ['en', 'ko'] as const) {
      it(`shows the ${kind} error in ${lang}`, async () => {
        setLang(lang);
        const r = rust(
          { exists: false, same: false },
          {
            skill_install: () => {
              throw { kind, message: 'raw-rust-text' };
            },
          },
        );
        await mount(r);
        fireEvent.click(button(t('skill.install')));
        await flush();
        const expected = kind === 'io' ? t('skill.err.io', 'raw-rust-text') : t(`skill.err.${kind}`);
        expect(expected).not.toBe(`skill.err.${kind}`);
        expect(screen.getByRole('alert').textContent).toBe(expected);
      });
    }
  }

  it('shows noHome when even the status fails', async () => {
    const r = rust(
      { exists: false, same: false },
      {
        skill_status: () => {
          throw { kind: 'noHome', message: 'x' };
        },
      },
    );
    await mount(r);
    expect(screen.getByRole('alert').textContent).toBe(t('skill.err.noHome'));
  });

  it('Copy uses the webview copy with SKILL_TEXT and calls no Rust command', async () => {
    const r = rust({ exists: false, same: false });
    const copy = vi.fn(async (_text: string) => undefined);
    await mount(r, copy);
    fireEvent.click(button(t('skill.copy')));
    await flush();
    expect(copy).toHaveBeenCalledWith(SKILL_TEXT);
    expect(cmds(r)).toEqual(['skill_status']);
  });

  it('Copy reports a clipboard refusal', async () => {
    const r = rust({ exists: false, same: false });
    const notes = await mount(r, async () => {
      throw new Error('denied');
    });
    fireEvent.click(button(t('skill.copy')));
    await flush();
    expect(notes).toEqual([{ kind: 'error', message: t('skill.copyFailed') }]);
  });

  it('Save as calls skill_save_as and reports the path', async () => {
    const r = rust({ exists: false, same: false });
    const notes = await mount(r);
    fireEvent.click(button(t('skill.saveAs')));
    await flush();
    expect(r.calls.filter(([c]) => c === 'skill_save_as')).toEqual([['skill_save_as', {}]]);
    expect(notes).toEqual([{ kind: 'info', message: t('skill.savedAs', 'D:/agents/SKILL.md') }]);
  });

  it('Save as reports nothing on cancel', async () => {
    const r = rust({ exists: false, same: false }, { skill_save_as: () => null });
    const notes = await mount(r);
    fireEvent.click(button(t('skill.saveAs')));
    await flush();
    expect(cmds(r)).toEqual(['skill_status', 'skill_save_as']);
    expect(notes).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
