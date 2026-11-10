/**
 * Task 7: which external MCP tools are on (spec §7.1). An explicit choice wins; otherwise only read-only,
 * non-destructive tools of preset servers are on. A tool whose schema was too large is never on.
 */
import { setToolEnabled, toolEnabled } from '../toolDefaults';
import type { McpServerSetting, McpToolInfo } from '../types';

const tool = (over: Partial<McpToolInfo> = {}): McpToolInfo => ({
  name: 'search',
  description: '',
  readOnly: false,
  destructive: false,
  openWorld: false,
  inputSchema: { type: 'object' },
  tooLarge: false,
  ...over,
});

const preset: McpServerSetting = { id: 'a1b2c3d4', name: 'RAPID', url: 'https://rapid.kbiofoundry.kr/mcp', auth: 'bearer', preset: 'rapid', enabled: true, tools: {} };
const custom: McpServerSetting = { id: '0badc0de', name: 'Mine', url: 'https://mcp.example.org/mcp', auth: 'none', enabled: true, tools: {} };

describe('toolEnabled defaults', () => {
  it('preset: read-only tools are on', () => {
    expect(toolEnabled(preset, tool({ readOnly: true }))).toBe(true);
  });
  it('preset: non-read-only or destructive tools are off', () => {
    expect(toolEnabled(preset, tool({ readOnly: false }))).toBe(false);
    expect(toolEnabled(preset, tool({ readOnly: true, destructive: true }))).toBe(false);
  });
  it('custom: every tool is off', () => {
    expect(toolEnabled(custom, tool({ readOnly: true }))).toBe(false);
    expect(toolEnabled(custom, tool())).toBe(false);
  });
  it('tooLarge: off even when chosen on', () => {
    expect(toolEnabled(preset, tool({ readOnly: true, tooLarge: true }))).toBe(false);
    expect(toolEnabled({ ...custom, tools: { search: true } }, tool({ tooLarge: true }))).toBe(false);
  });
  it('an explicit choice wins over the default', () => {
    expect(toolEnabled({ ...custom, tools: { search: true } }, tool())).toBe(true);
    expect(toolEnabled({ ...preset, tools: { search: false } }, tool({ readOnly: true }))).toBe(false);
  });
  it('a choice for another tool does not count', () => {
    expect(toolEnabled({ ...custom, tools: { other: true } }, tool())).toBe(false);
  });
  it('an inherited object key is not a choice', () => {
    expect(toolEnabled(custom, tool({ name: 'constructor' }))).toBe(false);
    expect(toolEnabled(custom, tool({ name: '__proto__' }))).toBe(false);
  });
});

describe('setToolEnabled', () => {
  it('records the choice without changing the input', () => {
    const next = setToolEnabled(custom, 'search', true);
    expect(next.tools).toEqual({ search: true });
    expect(custom.tools).toEqual({});
    expect(setToolEnabled(next, 'search', false).tools).toEqual({ search: false });
  });
  it('keeps other choices', () => {
    expect(setToolEnabled({ ...custom, tools: { a: true } }, 'b', false).tools).toEqual({ a: true, b: false });
  });
});
