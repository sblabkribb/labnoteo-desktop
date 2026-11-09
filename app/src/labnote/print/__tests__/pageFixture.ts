import type { PrintPage } from '../../port/printPages';

/** A printable page for tests; `over` replaces fields. */
export const page = (over: Partial<PrintPage> = {}): PrintPage => ({
  payload: 'LN1:LN-7K3M9QX2:1:UHW010:1/1:261015',
  label: 'L',
  header: '<h1>T</h1>',
  body: '<p>x</p>',
  footer: 'F',
  ...over,
});
