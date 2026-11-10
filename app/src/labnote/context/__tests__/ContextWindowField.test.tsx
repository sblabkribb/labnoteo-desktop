// @vitest-environment jsdom
/** The context-window field of Integration settings (Task 17): presets, a custom value, clamping, saving. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { styleAttributes } from '../../host/__tests__/harness';
import { ContextWindowField } from '../ContextWindowField';
import { WINDOW_PRESETS } from '../sourcesModel';
import { isPresetWindow, parseWindowInput } from '../windowSetting';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => undefined);
}

function mount(value: number) {
  const commit = vi.fn(async (_patch: { llmContextWindow: number }) => undefined);
  render(<ContextWindowField value={value} commit={commit} />);
  return commit;
}

const select = () => screen.getByLabelText(t('aiCtx.window.label')) as HTMLSelectElement;
const custom = () => screen.queryByLabelText(t('aiCtx.window.customLabel')) as HTMLInputElement | null;

describe('windowSetting', () => {
  it('parses and clamps a typed value', () => {
    expect(parseWindowInput('4096')).toBe(4096);
    expect(parseWindowInput(' 12000 ')).toBe(12000);
    expect(parseWindowInput('100')).toBe(2048);
    expect(parseWindowInput('2047')).toBe(2048);
    expect(parseWindowInput('2000000')).toBe(1_000_000);
    expect(parseWindowInput('1000000')).toBe(1_000_000);
    expect(parseWindowInput('')).toBeNull();
    expect(parseWindowInput('x')).toBeNull();
    expect(parseWindowInput('4096.5')).toBeNull();
    expect(parseWindowInput('-5')).toBeNull();
    expect(parseWindowInput('1e9')).toBeNull();
  });
  it('knows the presets', () => {
    expect(isPresetWindow(8192)).toBe(true);
    expect(isPresetWindow(12000)).toBe(false);
  });
});

describe('ContextWindowField', () => {
  it('offers every preset plus a custom choice and shows the saved preset', () => {
    mount(8192);
    const values = [...select().options].map((o) => o.value);
    expect(values).toEqual([...WINDOW_PRESETS.map(String), 'custom']);
    expect(select().value).toBe('8192');
    expect(custom()).toBeNull();
    expect(styleAttributes()).toEqual([]);
  });

  it('saves a preset through the patch', async () => {
    const commit = mount(8192);
    fireEvent.change(select(), { target: { value: '32768' } });
    await flush();
    expect(commit).toHaveBeenCalledWith({ llmContextWindow: 32768 });
    expect(select().value).toBe('32768');
  });

  it('shows a non-preset saved value as custom', () => {
    mount(12000);
    expect(select().value).toBe('custom');
    expect(custom()!.value).toBe('12000');
  });

  it('choosing custom saves nothing until a value is committed', async () => {
    const commit = mount(8192);
    fireEvent.change(select(), { target: { value: 'custom' } });
    await flush();
    expect(commit).not.toHaveBeenCalled();
    expect(custom()!.value).toBe('8192');
    fireEvent.change(custom()!, { target: { value: '12000' } });
    fireEvent.blur(custom()!);
    await flush();
    expect(commit).toHaveBeenCalledWith({ llmContextWindow: 12000 });
  });

  it('clamps a custom value and shows the clamped number', async () => {
    const commit = mount(12000);
    fireEvent.change(custom()!, { target: { value: '100' } });
    fireEvent.blur(custom()!);
    await flush();
    expect(commit).toHaveBeenLastCalledWith({ llmContextWindow: 2048 });
    expect(custom()!.value).toBe('2048');
    fireEvent.change(custom()!, { target: { value: '5000000' } });
    fireEvent.keyDown(custom()!, { key: 'Enter' });
    await flush();
    expect(commit).toHaveBeenLastCalledWith({ llmContextWindow: 1_000_000 });
  });

  it('refuses a non-number and does not save', async () => {
    const commit = mount(12000);
    fireEvent.change(custom()!, { target: { value: 'abc' } });
    fireEvent.blur(custom()!);
    await flush();
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByText(t('aiCtx.window.invalid'))).toBeTruthy();
  });

  it('does not save an unchanged value', async () => {
    const commit = mount(12000);
    fireEvent.blur(custom()!);
    await flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it('renders with Korean labels', () => {
    setLang('ko');
    mount(8192);
    expect(t('aiCtx.window.label')).not.toBe('aiCtx.window.label');
    expect(select()).toBeTruthy();
  });
});
