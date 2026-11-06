import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { EXTERNAL_SCHEMES, openExternal, type ExternalDeps } from '../openExternal';

let opened: string[];
let copied: string[];
let notes: { kind: 'info' | 'warn'; message: string }[];
let failOpen: boolean;
let deps: ExternalDeps;

beforeEach(() => {
  opened = [];
  copied = [];
  notes = [];
  failOpen = false;
  deps = {
    open: async (url) => {
      if (failOpen) throw new Error('refused');
      opened.push(url);
    },
    copy: async (text) => {
      copied.push(text);
    },
    notify: (kind, message) => {
      notes.push({ kind, message });
    },
  };
});

describe('openExternal', () => {
  it('opens allowed schemes', async () => {
    expect(await openExternal('https://doi.org/x', deps)).toBe('opened');
    expect(await openExternal('partbank://part/1', deps)).toBe('opened');
    expect(opened).toEqual(['https://doi.org/x', 'partbank://part/1']);
  });
  it('copies refused schemes and failed opens', async () => {
    expect(await openExternal('file:///C:/x', deps)).toBe('copied');
    expect(notes.at(-1)).toEqual({ kind: 'warn', message: t('links.external.copied', 'file:///C:/x') });
    failOpen = true;
    expect(await openExternal('https://a.b', deps)).toBe('copied');
    expect(notes.at(-1)).toEqual({ kind: 'warn', message: t('links.external.failed', 'https://a.b') });
    expect(copied).toEqual(['file:///C:/x', 'https://a.b']);
  });
  it('matches the schemes the capability allows, case-insensitively', () => {
    for (const u of ['http://a', 'HTTPS://a', 'mailto:x@y.z', 'partbank:1']) expect(EXTERNAL_SCHEMES.test(u)).toBe(true);
    for (const u of ['file:///x', 'javascript:alert(1)', 'ftp://a', 'C:/x']) expect(EXTERNAL_SCHEMES.test(u)).toBe(false);
  });
  it('still reports when the clipboard copy fails', async () => {
    deps.copy = async () => {
      throw new Error('no clipboard');
    };
    expect(await openExternal('file:///C:/x', deps)).toBe('copied');
    expect(notes.at(-1)).toEqual({ kind: 'warn', message: t('links.external.copied', 'file:///C:/x') });
  });
});
