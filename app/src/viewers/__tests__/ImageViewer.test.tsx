// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { ImageViewer } from '../ImageViewer';
import { StatusBar } from '../../ui/StatusBar';

const created: Blob[] = [];
beforeEach(() => {
  invoke.mockReset();
  created.length = 0;
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'vault_read_image') return new Uint8Array(2048).buffer;
    return undefined;
  });
  URL.createObjectURL = (b: Blob) => {
    created.push(b as Blob);
    return 'blob:img-1';
  };
  URL.revokeObjectURL = vi.fn();
});

async function loaded(path = 'exp/resources/gel.png') {
  const view = render(
    <>
      <ImageViewer path={path} />
      <StatusBar viewerPath={path} onReveal={() => {}} />
    </>,
  );
  const img = await screen.findByRole('img', { name: path.slice(path.lastIndexOf('/') + 1) });
  return { view, img: img as HTMLImageElement };
}

function natural(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { value: w });
  Object.defineProperty(img, 'naturalHeight', { value: h });
  fireEvent.load(img);
}

describe('ImageViewer', () => {
  it('shows the picture on a checkerboard, fitted, with no style attribute, and its size in the status bar', async () => {
    const { view, img } = await loaded();
    expect(invoke).toHaveBeenCalledWith('vault_read_image', { path: 'exp/resources/gel.png' });
    expect(img.getAttribute('src')).toBe('blob:img-1');
    expect(created[0].type).toBe('image/png');
    expect(img.closest('.image-stage')!.classList.contains('checker')).toBe(true);
    expect(img.dataset.zoom).toBe('fit');
    expect(view.container.querySelector('[style]')).toBeNull();
    natural(img, 640, 480);
    expect(await screen.findByText('640 × 480 px')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
  });

  it('+ zooms through --zoom (CSSOM), 0 returns to fit, 1:1 is 100%', async () => {
    const { img } = await loaded();
    natural(img, 100, 100);
    fireEvent.click(screen.getByRole('button', { name: '확대' }));
    expect(img.dataset.zoom).toBe('scale');
    const z = Number(img.style.getPropertyValue('--zoom'));
    expect(z).toBeGreaterThan(1);
    const viewer = img.closest<HTMLElement>('.image-viewer')!;
    act(() => void fireEvent.keyDown(viewer, { key: '+' }));
    const z2 = Number(img.style.getPropertyValue('--zoom'));
    expect(z2).toBeGreaterThan(z);
    expect(viewer.querySelector('.viewer-zoom')!.textContent).toBe(`${Math.round(z2 * 100)}%`);
    act(() => void fireEvent.keyDown(viewer, { key: '0' }));
    expect(img.dataset.zoom).toBe('fit');
    expect(img.style.getPropertyValue('--zoom')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '실제 크기' }));
    expect(img.style.getPropertyValue('--zoom')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: '축소' }));
    expect(Number(img.style.getPropertyValue('--zoom'))).toBeLessThan(1);
  });

  it('an svg is shown only as a blob image with the svg type', async () => {
    await loaded('diagram.svg');
    expect(created[0].type).toBe('image/svg+xml');
  });

  it('open and reveal call the Rust commands', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: '기본 앱으로 열기' }));
    fireEvent.click(screen.getByRole('button', { name: '폴더에서 보기' }));
    expect(invoke).toHaveBeenCalledWith('vault_open_default', { path: 'exp/resources/gel.png' });
    expect(invoke).toHaveBeenCalledWith('vault_reveal', { path: 'exp/resources/gel.png' });
  });

  it('a picture too large to read falls back to the file card', async () => {
    invoke.mockImplementation(async () => {
      throw { kind: 'tooLarge', message: 'big' };
    });
    render(<ImageViewer path="big.png" />);
    expect(await screen.findByRole('article', { name: '파일' })).toBeTruthy();
    expect(screen.getByText('파일이 너무 커서 앱 안에서 보이지 않습니다(20 MiB 초과). 기본 앱으로 여세요.')).toBeTruthy();
  });
});
