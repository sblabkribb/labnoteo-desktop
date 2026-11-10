// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { FileCard } from '../FileCard';
import { clearToasts, currentToasts } from '../../labnote/host/toastStore';

beforeEach(() => {
  invoke.mockReset();
  clearToasts();
});

describe('FileCard', () => {
  it('shows the name, the folder and the kind of a non-note file without reading it', () => {
    invoke.mockResolvedValue({ size: 2048, modified: null });
    const { container } = render(<FileCard path="labnote/001_PCR/resources/spec.pdf" kind="pdf" />);
    expect(screen.getByRole('heading', { name: 'spec.pdf' })).toBeTruthy();
    expect(screen.getByText('labnote/001_PCR/resources')).toBeTruthy();
    expect(screen.getByText('PDF 문서')).toBeTruthy();
    expect(container.querySelector('svg.lucide-file-type')).not.toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
    // only the file's facts are asked for, never its bytes
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(['vault_file_info']);
  });

  it('shows the size and the modified date (spec §6.1)', async () => {
    const modified = new Date(2026, 10, 9, 14, 5).getTime();
    invoke.mockResolvedValue({ size: 2048, modified });
    render(<FileCard path="exp/resources/spec.pdf" kind="pdf" />);
    expect(await screen.findByText('2 KB')).toBeTruthy();
    expect(screen.getByText('2026-11-09 14:05')).toBeTruthy();
    expect(screen.getByText('크기')).toBeTruthy();
    expect(screen.getByText('수정한 날')).toBeTruthy();
  });

  it('a file at the vault root says so', () => {
    invoke.mockResolvedValue({ size: 1, modified: null });
    render(<FileCard path="data.zip" kind="other" />);
    expect(screen.getByText('보관함 맨 위')).toBeTruthy();
    expect(screen.getByText('첨부 파일')).toBeTruthy();
  });

  it('opens with the default app and shows in the folder through Rust', async () => {
    invoke.mockResolvedValue(undefined);
    render(<FileCard path="exp/resources/spec.pdf" kind="pdf" />);
    fireEvent.click(screen.getByRole('button', { name: '기본 앱으로 열기' }));
    fireEvent.click(screen.getByRole('button', { name: '폴더에서 보기' }));
    expect(invoke).toHaveBeenCalledWith('vault_open_default', { path: 'exp/resources/spec.pdf' });
    expect(invoke).toHaveBeenCalledWith('vault_reveal', { path: 'exp/resources/spec.pdf' });
  });

  it('a refused open is a warning toast, not a silent failure', async () => {
    invoke.mockRejectedValue({ kind: 'badInput', message: 'x.xyz: this kind of file is not opened from labnoteO' });
    render(<FileCard path="x.xyz" kind="other" />);
    fireEvent.click(screen.getByRole('button', { name: '기본 앱으로 열기' }));
    await waitFor(() => expect(currentToasts()).toHaveLength(1));
    expect(currentToasts()[0].kind).toBe('warn');
    expect(currentToasts()[0].detail ?? currentToasts()[0].message).toContain('x.xyz');
  });

  it('shows why a viewer could not show the file', () => {
    invoke.mockResolvedValue({ size: 1, modified: null });
    render(<FileCard path="big.png" kind="image" reason="이유" />);
    expect(screen.getByText('이유')).toBeTruthy();
  });
});
