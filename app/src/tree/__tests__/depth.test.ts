import { depthAttrs, INDENT_CAP, MAX_DEPTH } from '../depth';

describe('depthAttrs', () => {
  it('passes shallow depths through without a class', () => {
    expect(depthAttrs(0)).toEqual({ 'data-depth': 0 });
    expect(depthAttrs(INDENT_CAP)).toEqual({ 'data-depth': INDENT_CAP });
  });
  it('marks rows deeper than INDENT_CAP as deep', () => {
    expect(depthAttrs(INDENT_CAP + 1)).toEqual({ 'data-depth': INDENT_CAP + 1, className: 'deep' });
  });
  it('clamps to MAX_DEPTH', () => {
    expect(depthAttrs(MAX_DEPTH + 7)).toEqual({ 'data-depth': MAX_DEPTH, className: 'deep' });
  });
});
