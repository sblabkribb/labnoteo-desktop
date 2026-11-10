// @vitest-environment jsdom
/**
 * "문헌 검색" 묶음(spec §8.4, Task 13): 출처 스위치 넷(기본 켬), NCBI API 키(쓰기만 하는 KeyField, 슬롯 ncbiEutils),
 * 연락처 이메일 두 칸(모양 검사 뒤 저장)과 도움말.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { fromPluginData } from '../../../labnote/settings';
import { styleAttributes } from '../../../labnote/host/__tests__/harness';
import { secretStatusOf } from '../../__tests__/fakeNet';
import { ScholarSection, type ScholarSettingsValue } from '../ScholarSection';

const KEY = 'test-ncbi-key-123';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

function setup(over: Partial<ScholarSettingsValue> = {}, isSet = false) {
  const d = fromPluginData(undefined);
  const value: ScholarSettingsValue = { scholarSources: d.scholarSources, ncbiEmail: d.ncbiEmail, crossrefMailto: d.crossrefMailto, ...over };
  const save = vi.fn(async () => true);
  const setSecret = vi.fn(async () => undefined);
  const clearSecret = vi.fn(async () => undefined);
  const status = vi.fn(async () => secretStatusOf({ ncbiEutils: true }));
  const onSaved = vi.fn();
  const hides: Array<() => Promise<void>> = [];
  const r = render(
    <ScholarSection
      value={value}
      save={save}
      deps={{ setSecret, clearSecret, status }}
      ncbiKeySet={isSet}
      onSaved={onSaved}
      onHide={(c) => hides.push(c)}
    />,
  );
  return { ...r, save, setSecret, clearSecret, status, onSaved, hides };
}

describe('ScholarSection', () => {
  it('shows the title, the help lines and four switches that are on by default', () => {
    setup();
    expect(screen.getByRole('heading', { name: t('scholar.title') })).toBeTruthy();
    expect(screen.getByText(t('scholar.help'))).toBeTruthy();
    expect(screen.getByText(t('scholar.emailHelp'))).toBeTruthy();
    const switches = screen.getAllByRole('switch') as HTMLInputElement[];
    expect(switches.map((s) => s.closest('label')!.textContent!.trim())).toEqual(['PubMed', 'Europe PMC', 'Crossref', 'bioRxiv']);
    expect(switches.every((s) => s.checked)).toBe(true);
  });

  it('a switch saves the whole sources object with that one source changed', async () => {
    const { save } = setup();
    fireEvent.click(screen.getByRole('switch', { name: 'Crossref' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ scholarSources: { pubmed: true, europepmc: true, crossref: false, biorxiv: true } }));
  });

  it('the NCBI key goes to the ncbiEutils slot, the field is cleared and the key never shows in the DOM', async () => {
    const { container, setSecret, onSaved } = setup();
    const input = screen.getByLabelText(t('scholar.ncbiKey')) as HTMLInputElement;
    input.value = KEY;
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(setSecret).toHaveBeenCalledWith('ncbiEutils', KEY));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(input.value).toBe('');
    expect(container.innerHTML).not.toContain(KEY);
    expect(styleAttributes()).toEqual([]);
  });

  it('saves a valid email on blur, trims it, and refuses one that is not an email', async () => {
    const { save } = setup();
    const ncbi = screen.getByLabelText(t('scholar.ncbiEmail')) as HTMLInputElement;
    fireEvent.change(ncbi, { target: { value: ' me@lab.example ' } });
    fireEvent.blur(ncbi);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ ncbiEmail: 'me@lab.example' }));

    const cr = screen.getByLabelText(t('scholar.crossrefMailto')) as HTMLInputElement;
    fireEvent.change(cr, { target: { value: 'not an email' } });
    fireEvent.blur(cr);
    expect(await screen.findByText(t('scholar.emailInvalid'))).toBeTruthy();
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ crossrefMailto: expect.anything() }));
  });

  it('emptying a stored email saves an empty value (nothing is sent)', async () => {
    const { save } = setup({ crossrefMailto: 'me@lab.example' });
    const cr = screen.getByLabelText(t('scholar.crossrefMailto')) as HTMLInputElement;
    expect(cr.value).toBe('me@lab.example');
    fireEvent.change(cr, { target: { value: '' } });
    fireEvent.blur(cr);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ crossrefMailto: '' }));
  });

  it('closing the settings saves a typed email that was never left', async () => {
    const { save, hides } = setup();
    fireEvent.change(screen.getByLabelText(t('scholar.ncbiEmail')), { target: { value: 'a@b.example' } });
    await act(async () => {
      for (const h of hides) await h();
    });
    expect(save).toHaveBeenCalledWith({ ncbiEmail: 'a@b.example' });
  });

  it('has Korean copy', () => {
    setLang('ko');
    setup();
    expect(screen.getByRole('heading', { name: '문헌 검색' })).toBeTruthy();
    expect(screen.getByText('넣으면 NCBI/Crossref에 연락처로 보내요. 비워 두면 보내지 않아요.')).toBeTruthy();
  });
});
