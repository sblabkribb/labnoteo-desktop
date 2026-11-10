import { describe, expect, it } from 'vitest';
import { contextTools } from '../../context/contextTools';
import { SKILL_TEXT } from '../skillText';

/** Splits `---\n<yaml>\n---\n<body>` into simple `key: value` pairs and the body. */
function frontMatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error('no front matter');
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`unparsable front-matter line: ${line}`);
    fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: m[2] };
}

/** The text of the `## <title...>` section up to the next `## ` heading. */
function section(text: string, title: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^## /.test(l) && title.test(l));
  if (start < 0) throw new Error(`no section ${title}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('SKILL.md', () => {
  it('has valid Claude Code skill front matter', () => {
    const { fields, body } = frontMatter(SKILL_TEXT);
    expect(fields.name).toBe('labnoteo');
    expect(fields.name).toMatch(/^[a-z0-9-]+$/);
    expect(fields.description.length).toBeGreaterThan(0);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    expect(Object.keys(fields).sort()).toEqual(['description', 'name']);
    expect(body).toMatch(/^# labnoteO/m);
  });

  it('names every context tool, the core tools it relies on and both prompts', () => {
    const names = contextTools().map(t => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of [
      ...names,
      'get_experiment_context',
      'get_unit_operation_context',
      'get_sample',
      'list_samples',
      'search_samples',
      'read_section',
      'update_section',
      'draft-unit-operation',
      'continue-workflow',
    ]) {
      expect(SKILL_TEXT, name).toContain(name);
    }
  });

  it('states the planning-only rule with every forbidden section', () => {
    const rule = section(SKILL_TEXT, /planning-only/i);
    for (const name of ['Results & Discussions', 'QC Metrics', 'Discussion', 'Meta']) {
      expect(rule, name).toContain(name);
    }
    expect(rule).toContain('(new:');
    expect(rule).toContain('(assumed)');
  });

  it('explains legacy names, the chain handoff and folder isolation', () => {
    expect(SKILL_TEXT).toContain('README.labnote.md');
    expect(SKILL_TEXT).toContain('README.md');
    expect(SKILL_TEXT).toContain('NNN_X.md');
    expect(SKILL_TEXT).toContain('Labware and Consumables');
    expect(SKILL_TEXT).toContain('Consumables');
    const chain = section(SKILL_TEXT, /chain/i);
    expect(chain).toMatch(/workflow N\b[\s\S]*workflow N\+1/);
    expect(section(SKILL_TEXT, /isolation/i)).toMatch(/names? (it|another)/i);
  });

  it('has a Korean section-name glossary', () => {
    for (const label of ['입력', '시약', '장비', '방법', '출력', '결과']) expect(SKILL_TEXT).toContain(label);
  });

  it('contains no host, port or token-like string', () => {
    expect(SKILL_TEXT).not.toMatch(/localhost/i);
    expect(SKILL_TEXT).not.toContain('127.0.0.1');
    expect(SKILL_TEXT).not.toMatch(/https?:\/\//i);
    expect(SKILL_TEXT).not.toMatch(/:\d{2,5}\b/);
    expect(SKILL_TEXT).not.toMatch(/\bport\s*\d/i);
    expect(SKILL_TEXT).not.toMatch(/[A-Za-z0-9_\-]{32,}/);
    expect(SKILL_TEXT).not.toMatch(/\b(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9]/);
    expect(SKILL_TEXT).not.toMatch(/bearer\s+\S/i);
  });
});
