// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Resizer, COLLAPSE_BELOW, KEY_STEP } from '../Resizer';

// jsdom 에는 PointerEvent 가 없다: clientX 와 pointerId 를 가진 MouseEvent 로 채운다.
class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') vi.stubGlobal('PointerEvent', PointerEventPolyfill);
});

function Harness(props: { onChange?: (w: number) => void; onCommit?: (w: number) => void; onCollapse?: () => void; side?: 'left' | 'right' }) {
  const [value, setValue] = useState(272);
  return (
    <Resizer
      side={props.side ?? 'left'}
      label="Sidebar width"
      min={200}
      max={480}
      defaultValue={272}
      value={value}
      onChange={(w) => {
        setValue(w);
        props.onChange?.(w);
      }}
      onCommit={props.onCommit}
      onCollapse={props.onCollapse ?? (() => undefined)}
    />
  );
}

const sep = () => screen.getByRole('separator', { name: 'Sidebar width' });

describe('Resizer', () => {
  it('is a focusable vertical separator with its value range', () => {
    render(<Harness />);
    expect(sep().getAttribute('aria-orientation')).toBe('vertical');
    expect(sep().getAttribute('aria-valuenow')).toBe('272');
    expect(sep().getAttribute('aria-valuemin')).toBe('200');
    expect(sep().getAttribute('aria-valuemax')).toBe('480');
    expect(sep().tabIndex).toBe(0);
    expect(sep().hasAttribute('style')).toBe(false);
  });

  it('a pointer drag from 272 to 400 reports 400 and commits once at the end', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<Harness onChange={onChange} onCommit={onCommit} />);
    fireEvent.pointerDown(sep(), { clientX: 272, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep(), { clientX: 330, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 400, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep(), { clientX: 400, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(400);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(400);
    expect(sep().getAttribute('aria-valuenow')).toBe('400');
  });

  it('clamps to the range while dragging, and a drag below the collapse line collapses', () => {
    const onChange = vi.fn();
    const onCollapse = vi.fn();
    render(<Harness onChange={onChange} onCollapse={onCollapse} />);
    fireEvent.pointerDown(sep(), { clientX: 272, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep(), { clientX: 900, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(480);
    fireEvent.pointerMove(sep(), { clientX: 160, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(200);
    expect(onCollapse).not.toHaveBeenCalled();
    fireEvent.pointerMove(sep(), { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(sep(), { clientX: 120, pointerId: 1 });
    expect(120).toBeLessThan(COLLAPSE_BELOW);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('a right-side handle grows when dragged to the left', () => {
    const onChange = vi.fn();
    render(<Harness side="right" onChange={onChange} />);
    fireEvent.pointerDown(sep(), { clientX: 1000, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep(), { clientX: 950, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(322);
  });

  it('arrow keys move it by 16px, Home and a double-click reset it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(272 + KEY_STEP);
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' });
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(272 - KEY_STEP);
    fireEvent.keyDown(sep(), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(272);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    fireEvent.doubleClick(sep());
    expect(onChange).toHaveBeenLastCalledWith(272);
    expect(KEY_STEP).toBe(16);
  });
});
