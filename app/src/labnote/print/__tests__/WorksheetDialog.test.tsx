// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorksheetUnitOp } from '@labnoteo/core/lib/worksheet';
import { t } from '../../../i18n/t';
import { currentDialog, worksheetDialog } from '../../host/dialogStore';
import { cleanupDialogs, openIn, renderLayer, settled, styleAttributes } from '../../host/__tests__/harness';
import { coreT } from '../../i18n';

afterEach(() => cleanupDialogs());

const op = (index: number, kind: 'hw' | 'sw', opId: string, opName: string, alias = ''): WorksheetUnitOp => ({
  index,
  kind,
  opId,
  opName,
  alias,
  description: '',
  sections: [],
});

const OPS = [op(0, 'hw', 'UHW010', 'PCR', 'colony'), op(1, 'sw', 'USW020', 'Align'), op(2, 'hw', 'UHW030', 'Gel')];

/** The text of the elements `el`'s aria-describedby names. */
const descriptionOf = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

const flush = () => act(async () => {});

describe('WorksheetDialog', () => {
  it('preselects lab unit ops, focuses Print and refuses an empty selection', async () => {
    renderLayer();
    const p = openIn(() => worksheetDialog(OPS, 'a4'));
    const dialog = screen.getByRole('dialog', { name: coreT('Print experiment worksheet') });
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true]);
    expect(screen.getByRole('checkbox', { name: '0. [UHW010 PCR] colony' })).toBe(boxes[0]);
    expect(descriptionOf(screen.getByRole('checkbox', { name: '1. [USW020 Align]' }))).toBe(coreT('Software'));
    expect(descriptionOf(boxes[2])).toBe(coreT('Lab'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: coreT('Print') }));
    expect(dialog.querySelector('.worksheet-ops')).not.toBeNull();
    expect(styleAttributes()).toEqual([]);

    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[2]);
    await userEvent.click(screen.getByRole('button', { name: coreT('Print') }));
    expect(screen.getByRole('alert').textContent).toBe(coreT('Select at least one unit operation.'));
    await flush();
    expect(settled(p).done).toBe(false);

    await userEvent.click(boxes[1]);
    await userEvent.click(screen.getByRole('button', { name: coreT('Open in browser') }));
    await expect(p).resolves.toEqual({ indices: [1], paper: 'a4', target: 'browser' });
  });

  it('does not print on Enter while composing', async () => {
    renderLayer();
    const p = openIn(() => worksheetDialog(OPS, 'a4'));
    const print = screen.getByRole('button', { name: coreT('Print') });
    fireEvent.keyDown(print, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(print, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(print, { key: 'Escape', isComposing: true });
    await flush();
    expect(settled(p).done).toBe(false);
    expect(currentDialog()).not.toBeNull();
    fireEvent.keyDown(print, { key: 'Enter' });
    await expect(p).resolves.toEqual({ indices: [0, 2], paper: 'a4', target: 'print' });
  });

  it('selects every unit op of a software-only note, and returns the chosen paper', async () => {
    renderLayer();
    const p = openIn(() => worksheetDialog([op(1, 'sw', 'USW010', 'A'), op(2, 'sw', 'USW020', 'B')], 'a4'));
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).map((b) => b.checked)).toEqual([true, true]);
    const select = screen.getByRole('combobox', { name: coreT('Paper size') }) as HTMLSelectElement;
    expect(select.value).toBe('a4');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['a4', t('print.paper.a4')],
      ['letter', t('print.paper.letter')],
    ]);
    await userEvent.selectOptions(select, 'letter');
    await userEvent.click(screen.getByRole('button', { name: coreT('Print') }));
    await expect(p).resolves.toEqual({ indices: [1, 2], paper: 'letter', target: 'print' });
  });

  it('Escape cancels with undefined', async () => {
    renderLayer();
    const p = openIn(() => worksheetDialog(OPS, 'letter'));
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBeUndefined();
  });
});
