/**
 * The cargo feature `e2e-fakes` lets a test exe's `fetch_page` reach exactly the loopback ports in
 * `LABNOTEO_E2E_FAKE_PORTS` (assistant spec §7.2 and §12, plan Task 13). It must never reach a build that users get:
 * not in Cargo's `default` features, not in the release or CI workflows, not in the npm build scripts and not in any
 * Tauri config (whose `beforeBuildCommand` or build args could pass it). Paths are relative to app/.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const CARGO = read('src-tauri/Cargo.toml');

/** The body of one TOML table (`[name]` up to the next table header). */
function table(toml: string, name: string): string | null {
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*\[/.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

describe('e2e-fakes never ships', () => {
  it('is declared as an empty cargo feature', () => {
    const features = table(CARGO, 'features');
    expect(features).not.toBeNull();
    expect(features!).toMatch(/^e2e-fakes\s*=\s*\[\s*\]\s*$/m);
  });

  it('is not a default feature, directly or through another feature', () => {
    const features = table(CARGO, 'features')!;
    const defaults = /^default\s*=\s*\[([^\]]*)\]/m.exec(features);
    if (defaults) expect(defaults[1]).not.toMatch(/e2e-fakes/);
    // No other feature turns it on, so a default could not pull it in later either.
    const enabling = features
      .split('\n')
      .filter((l) => /=/.test(l) && !/^\s*#/.test(l) && !/^e2e-fakes\s*=/.test(l))
      .filter((l) => /e2e-fakes/.test(l));
    expect(enabling).toEqual([]);
    // No dependency line of this crate enables it either.
    expect(CARGO.split('\n').filter((l) => !/^\s*#/.test(l) && /e2e-fakes/.test(l))).toEqual(['e2e-fakes = []']);
  });

  it('is absent from the release workflow, including the tauri-action args', () => {
    const release = read('../.github/workflows/release.yml');
    expect(release).not.toMatch(/e2e-fakes/);
    const args = /^\s*args:\s*(.*)$/m.exec(release);
    expect(args, 'tauri-action args').not.toBeNull();
    expect(args![1]).not.toMatch(/--features|e2e/);
  });

  it('is absent from the CI workflow', () => {
    expect(read('../.github/workflows/ci.yml')).not.toMatch(/e2e-fakes/);
  });

  it('is absent from the npm build scripts and the Tauri configs', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const name of ['build', 'tauri:build', 'tauri']) {
      expect(pkg.scripts[name] ?? '', name).not.toMatch(/e2e-fakes/);
    }
    for (const conf of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.release.conf.json']) {
      expect(read(conf), conf).not.toMatch(/e2e-fakes/);
    }
  });

  it('is read only under the feature: release code paths never see LABNOTEO_E2E_FAKE_PORTS', () => {
    const fetchPage = read('src-tauri/src/net/fetch_page.rs');
    const lines = fetchPage.split('\n');
    const envLine = lines.findIndex((l) => l.includes('std::env::var("LABNOTEO_E2E_FAKE_PORTS")'));
    expect(envLine).toBeGreaterThan(0);
    // The function that reads it is gated by the feature.
    const gate = lines.slice(0, envLine).reverse().find((l) => /#\[cfg\(/.test(l));
    expect(gate?.trim()).toBe('#[cfg(feature = "e2e-fakes")]');
    // The loopback-port constructor exists only in tests and the feature build.
    expect(fetchPage).toMatch(/#\[cfg\(any\(test, feature = "e2e-fakes"\)\)\]\n\s*pub fn with_loopback_ports/);
  });
});
