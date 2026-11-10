// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../../i18n/lang';
import { newExperimentDialog } from '../../host/dialogStore';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from '../../host/__tests__/harness';

beforeEach(() => setLang('ko'));
afterEach(() => cleanupDialogs());

const titleBox = () => screen.getByRole('textbox', { name: '실험 제목' });
const experimenterBox = () => screen.getByRole('textbox', { name: '실험자' }) as HTMLInputElement;

describe('새 실험 대화상자', () => {
  it('pre-fills the experimenter, focuses the title and resolves { title, experimenter }', async () => {
    renderLayer();
    const p = openIn(() => newExperimentDialog({ title: '새 실험', experimenter: '김연구' }));
    expect(screen.getByRole('dialog', { name: '새 실험' })).toBeTruthy();
    expect(experimenterBox().value).toBe('김연구');
    expect(document.activeElement).toBe(titleBox());
    expect(styleAttributes()).toEqual([]);
    await userEvent.type(titleBox(), 'GFP assay');
    await userEvent.clear(experimenterBox());
    await userEvent.type(experimenterBox(), 'Alex{Enter}');
    await expect(p).resolves.toEqual({ title: 'GFP assay', experimenter: 'Alex' });
  });

  it('a failed title check shows the message and keeps the dialog open', async () => {
    renderLayer();
    const p = openIn(() =>
      newExperimentDialog({ title: '새 실험', experimenter: '', validate: (v) => (v.trim() ? null : '제목을 적어 주세요.') }),
    );
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('제목을 적어 주세요.');
    await userEvent.type(titleBox(), 'x{Enter}');
    await expect(p).resolves.toEqual({ title: 'x', experimenter: '' });
  });

  it('shows the title hint and Escape cancels', async () => {
    renderLayer();
    const p = openIn(() => newExperimentDialog({ title: '새 실험', experimenter: '', hint: (v) => ({ text: `hint:${v}`, warn: true }) }));
    await userEvent.type(titleBox(), 'a');
    expect(screen.getByText('hint:a').classList.contains('warn')).toBe(true);
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBeUndefined();
  });
});
