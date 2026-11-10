// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { FileCard } from '../FileCard';

describe('FileCard (until the viewers of Task 18)', () => {
  it('shows the name, the folder and the kind of a non-note file without reading it', () => {
    const { container } = render(<FileCard path="labnote/001_PCR/images/gel.png" kind="image" />);
    expect(screen.getByRole('heading', { name: 'gel.png' })).toBeTruthy();
    expect(screen.getByText('labnote/001_PCR/images')).toBeTruthy();
    expect(screen.getByText('그림')).toBeTruthy();
    expect(container.querySelector('svg.lucide-image')).not.toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a file at the vault root says so', () => {
    render(<FileCard path="data.zip" kind="other" />);
    expect(screen.getByText('보관함 맨 위')).toBeTruthy();
    expect(screen.getByText('첨부 파일')).toBeTruthy();
  });
});
