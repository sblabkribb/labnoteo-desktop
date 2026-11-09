import { afterEach, describe, expect, it } from 'vitest';
import { partbank, setPartbankFeature } from '../current';
import { PartbankFeature } from '../../labnote/port/partbankFeature';
import { coreT } from '../../labnote/i18n';
import { fromPluginData } from '../../labnote/settings';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';

const deps = {
  settings: () => fromPluginData(undefined),
  host: { notify: () => undefined, t: coreT },
  invoke: fakeInvoke({}).invoke,
};

afterEach(() => setPartbankFeature(undefined));

describe('partbank()', () => {
  it('partbank() returns the feature set for the vault, undefined after reset', () => {
    const f = new PartbankFeature(deps);
    setPartbankFeature(f);
    expect(partbank()).toBe(f);
    setPartbankFeature(undefined);
    expect(partbank()).toBeUndefined();
  });
});
