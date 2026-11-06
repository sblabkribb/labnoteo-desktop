import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('capabilities', () => {
  it('scopes the opener to http, https, mailto and partbank', () => {
    const cap = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf-8'));
    const entry = cap.permissions.find(
      (p: unknown) => typeof p === 'object' && (p as { identifier: string }).identifier === 'opener:allow-open-url',
    );
    expect(entry.allow).toEqual([{ url: 'http://*' }, { url: 'https://*' }, { url: 'mailto:*' }, { url: 'partbank:*' }]);
    expect(cap.permissions).not.toContain('opener:default');
  });
});
