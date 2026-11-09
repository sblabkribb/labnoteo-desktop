// @vitest-environment jsdom
/**
 * 아이콘 하나의 감싸개(Icon.tsx). 모든 이름이 Lucide SVG 로 그려지고, 굵기 1.75·크기·접근성 속성이 맞으며,
 * CSP(style-src 'self') 때문에 어떤 요소에도 style 속성이 없다. lucide-react 는 Icon.tsx 만 가져온다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from '../Icon';

afterEach(cleanup);

describe('Icon', () => {
  it('has a non-trivial closed set of names', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(50);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  it.each(ICON_NAMES)('%s renders a decorative svg with stroke 1.75 and the default size 16', (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('stroke-width')).toBe('1.75');
    expect(svg!.getAttribute('width')).toBe('16');
    expect(svg!.getAttribute('height')).toBe('16');
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(svg!.hasAttribute('role')).toBe(false);
    expect(svg!.hasAttribute('aria-label')).toBe(false);
    expect(svg!.getAttribute('focusable')).toBe('false');
    expect(svg!.classList.contains('icon')).toBe(true);
    // CSP: no element of any icon carries a style attribute
    expect(container.querySelectorAll('[style]').length).toBe(0);
    expect(svg!.querySelectorAll('*').length).toBeGreaterThan(0);
  });

  it.each([14, 16, 18] as const)('size %i sets width and height', (size) => {
    const { container } = render(<Icon name="search" size={size} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe(String(size));
    expect(svg.getAttribute('height')).toBe(String(size));
    expect(svg.getAttribute('stroke-width')).toBe('1.75');
  });

  it('a labelled icon is an image with an accessible name and is not hidden', () => {
    const { getByRole, container } = render(<Icon name="settings" label="Settings" className="extra" />);
    const img = getByRole('img', { name: 'Settings' });
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(img.hasAttribute('aria-hidden')).toBe(false);
    expect(img.classList.contains('icon')).toBe(true);
    expect(img.classList.contains('extra')).toBe(true);
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });
});

describe('lucide-react import guard', () => {
  const SRC = join(__dirname, '..', '..');
  function walk(dir: string, out: string[]): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p);
    }
    return out;
  }

  // 따옴표가 든 정규식은 String.raw 로 쓴다(escapes.test.ts 가 정규식 리터럴 안의 따옴표를 문자열의 시작으로 읽는다)
  const IMPORTS_LUCIDE = new RegExp(String.raw`(from\s*|import\s*\(?\s*|require\s*\(\s*)['"]lucide-react(/[^'"]*)?['"]`);

  it('no file other than src/ui/Icon.tsx imports lucide-react', () => {
    const files = walk(SRC, []);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => !f.endsWith(`${sep}__tests__${sep}Icon.test.tsx`))
      .filter((f) => IMPORTS_LUCIDE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'));
    expect(offenders).toEqual(['ui/Icon.tsx']);
  });
});
