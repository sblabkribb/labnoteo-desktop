// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { currentDialog } from '../../labnote/host/dialogStore';
import { cleanupDialogs, renderLayer, styleAttributes } from '../../labnote/host/__tests__/harness';
import { cancelAllRequests } from '../netIpc';
import { openProgress, withProgress, type ProgressHandle } from '../progressStore';

beforeEach(() => setLang('en'));
afterEach(() => cleanupDialogs());

function open(title: string, opts?: { cancellable?: boolean }): ProgressHandle {
  let p!: ProgressHandle;
  act(() => {
    p = openProgress(title, opts);
  });
  return p;
}

describe('progress dialog', () => {
  it('shows the title and appended lines', async () => {
    renderLayer();
    const p = open('Contacting Ollama…');
    act(() => {
      p.line('init');
      p.line('generate');
    });
    expect(screen.getByRole('dialog', { name: 'Contacting Ollama…' })).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['init', 'generate']);
    expect(document.querySelector('.progress-lines')?.getAttribute('aria-live')).toBe('polite');
    expect(styleAttributes()).toEqual([]);
    act(() => p.done());
  });

  it('Cancel aborts the signal and closes', async () => {
    renderLayer();
    const p = open('Working', { cancellable: true });
    expect(p.signal.aborted).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentDialog()).toBeNull();
  });

  it('Escape aborts the signal and closes, but not while composing', async () => {
    renderLayer();
    const p = open('Working', { cancellable: true });
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(p.signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();

    const q = open('Working', { cancellable: true });
    const dialog = screen.getByRole('dialog');
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    });
    expect(q.signal.aborted).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => q.done());
  });

  it('done closes and a second done is harmless', () => {
    renderLayer();
    const p = open('Working');
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => p.done());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(p.signal.aborted).toBe(false);
    act(() => p.done());
    expect(currentDialog()).toBeNull();
    expect(p.signal.aborted).toBe(false);
  });

  it('without cancellable there is no Cancel button', () => {
    renderLayer();
    const p = open('Working');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    act(() => p.done());
  });

  it('keeps the last 200 lines', () => {
    renderLayer();
    const p = open('Working');
    act(() => {
      for (let i = 0; i < 250; i++) p.line(`line ${i}`);
    });
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(200);
    expect(items[0].textContent).toBe('line 50');
    expect(items[199].textContent).toBe('line 249');
    act(() => p.done());
  });

  it('withProgress closes even when run throws', async () => {
    renderLayer();
    let run!: Promise<unknown>;
    act(() => {
      run = withProgress('Working', async (p) => {
        p.line('one');
        throw new Error('boom');
      });
    });
    await act(async () => {
      await expect(run).rejects.toThrow('boom');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentDialog()).toBeNull();
  });

  it('withProgress returns the value and its signal aborts on a vault switch', async () => {
    renderLayer();
    let seen!: AbortSignal;
    let release!: () => void;
    let run!: Promise<string>;
    act(() => {
      run = withProgress(
        'Working',
        (p) => {
          seen = p.signal;
          return new Promise<string>((resolve) => {
            release = () => resolve('ok');
          });
        },
        { cancellable: true },
      );
    });
    expect(seen.aborted).toBe(false);
    act(() => {
      void cancelAllRequests();
    });
    expect(seen.aborted).toBe(true);
    release();
    await act(async () => {
      await expect(run).resolves.toBe('ok');
    });
    expect(currentDialog()).toBeNull();
  });

  it('setCancellable(false) hides Cancel, disables Close, and Escape no longer aborts', async () => {
    renderLayer();
    const p = open('Uploading', { cancellable: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    act(() => p.setCancellable(false));
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    const dialog = screen.getByRole('dialog');
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(p.signal.aborted).toBe(false);
    // the locked window's close button is disabled, so keyboard users never land on a dead control
    const close = screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    await userEvent.click(close);
    expect(p.signal.aborted).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => p.setCancellable(true));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => p.done());
    expect(p.signal.aborted).toBe(false);
  });

  it('uses Korean labels', () => {
    setLang('ko');
    renderLayer();
    const p = open('작업', { cancellable: true });
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();
    act(() => p.done());
  });
});
