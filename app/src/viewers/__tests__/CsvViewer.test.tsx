// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { CsvViewer, ROW_PX, WINDOW_ROWS } from '../CsvViewer';
import { StatusBar } from '../../ui/StatusBar';

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

function serve(text: string | ArrayBuffer) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'vault_read_bytes') return typeof text === 'string' ? bytes(text) : text;
    throw new Error(`unexpected ${cmd}`);
  });
}

beforeEach(() => {
  invoke.mockReset();
});

const CSV = '﻿시료,well,od600,note\nDNA-1,A1,0.52,"ok, fine"\nDNA-2,A2,0.61,\nDNA-3,A3,1.2e-1,redo\n';

describe('CsvViewer', () => {
  it('reads the bytes, shows a sticky header, a pinned first column, numeric columns right-aligned and zebra rows', async () => {
    serve(CSV);
    const { container } = render(
      <>
        <CsvViewer path="exp/resources/plate.csv" />
        <StatusBar viewerPath="exp/resources/plate.csv" onReveal={() => {}} />
      </>,
    );
    const table = await screen.findByRole('table');
    expect(invoke).toHaveBeenCalledWith('vault_read_bytes', { path: 'exp/resources/plate.csv' });
    expect(table.querySelector('thead.sticky')).not.toBeNull();
    expect(within(table).getByRole('columnheader', { name: '시료' }).classList.contains('pinned')).toBe(true);
    const body = table.querySelectorAll('tbody tr');
    expect(body).toHaveLength(3);
    expect(body[0].querySelector('td')!.classList.contains('pinned')).toBe(true);
    // od600 is numeric, well and note are not
    expect(body[0].children[2].classList.contains('num')).toBe(true);
    expect(body[0].children[1].classList.contains('num')).toBe(false);
    expect(body[0].children[3].textContent).toBe('ok, fine');
    expect(within(table).getByRole('columnheader', { name: 'od600' }).classList.contains('num')).toBe(true);
    expect([...body].map((r) => r.classList.contains('alt'))).toEqual([false, true, false]);
    expect(screen.getByText('3행 × 4열')).toBeTruthy();
    expect(screen.getByText('UTF-8')).toBeTruthy();
    expect(screen.getByText('쉼표 구분')).toBeTruthy();
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('decodes EUC-KR and shows the raw text with the toggle', async () => {
    // "시료,값\n1,2" in EUC-KR
    serve(new Uint8Array([0xbd, 0xc3, 0xb7, 0xe1, 0x2c, 0xb0, 0xaa, 0x0a, 0x31, 0x2c, 0x32]).buffer);
    render(
      <>
        <CsvViewer path="a.csv" />
        <StatusBar viewerPath="a.csv" onReveal={() => {}} />
      </>,
    );
    expect(await screen.findByRole('columnheader', { name: '시료' })).toBeTruthy();
    expect(screen.getByText('EUC-KR')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: '텍스트로 보기' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelector('pre.csv-raw')!.textContent).toBe('시료,값\n1,2');
    fireEvent.click(toggle);
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('a .tsv splits on tabs', async () => {
    serve('a,b\tc\n1,2\t3');
    render(<CsvViewer path="x.tsv" />);
    expect(await screen.findByRole('columnheader', { name: 'a,b' })).toBeTruthy();
  });

  it('5,000 rows render at most one window of rows, with spacers sized through CSSOM', async () => {
    const lines = ['i,v'];
    for (let i = 0; i < 5000; i++) lines.push(`r${i},${i * 2}`);
    serve(lines.join('\n'));
    render(<CsvViewer path="big.csv" />);
    const table = await screen.findByRole('table');
    expect(table.querySelectorAll('tr').length).toBeLessThan(2100);
    expect(WINDOW_ROWS).toBeLessThanOrEqual(2000);
    const after = table.querySelector<HTMLElement>('tr.csv-spacer-after')!;
    expect(after.style.getPropertyValue('--csv-pad')).toBe(`${(5000 - WINDOW_ROWS) * ROW_PX}px`);
    expect(table.querySelector('tr.csv-spacer-before')).toBeNull();
    // scrolling far down moves the window
    const scroller = document.querySelector<HTMLElement>('.csv-scroll')!;
    await act(async () => {
      scroller.scrollTop = 4500 * ROW_PX;
      fireEvent.scroll(scroller);
    });
    expect(within(table).getByText('r4500')).toBeTruthy();
    expect(within(table).queryByText('r10')).toBeNull();
    expect(table.querySelector<HTMLElement>('tr.csv-spacer-before')!.style.getPropertyValue('--csv-pad')).not.toBe('');
    expect(table.querySelectorAll('tr').length).toBeLessThan(2100);
  });

  it('a read failure falls back to the file card with the reason', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'vault_read_bytes') throw { kind: 'tooLarge', message: 'too large' };
      return undefined;
    });
    render(<CsvViewer path="huge.csv" />);
    expect(await screen.findByRole('article', { name: '파일' })).toBeTruthy();
    expect(screen.getByText('파일이 너무 커서 앱 안에서 보이지 않습니다(50 MiB 초과). 기본 앱으로 여세요.')).toBeTruthy();
  });
});
