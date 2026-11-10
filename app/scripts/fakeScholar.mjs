#!/usr/bin/env node
/**
 * Fake scholarly services for the real-app check (plan Task 16). TEST HELPER ONLY: never bundled.
 *
 *   node scripts/fakeScholar.mjs [--port 47831]
 *
 * - Binds 127.0.0.1 only. `--port 0` picks a free port; the base URL is printed on stdout. Start the debug test
 *   exe with `LABNOTEO_TEST_SCHOLAR_BASE=<that URL>`: the app then asks `<base>/pubmed/…`, `<base>/europepmc/…`,
 *   `<base>/crossref/…` and `<base>/biorxiv/…` (src-tauri/src/net/scholar/mod.rs).
 * - Canned answers in the shapes the Rust clients read: PubMed esearch/esummary/efetch, Europe PMC search,
 *   Crossref works (search and by DOI), bioRxiv details (by DOI and by date range).
 * - GET /__log: the request log as JSON (host, path, query). An `api_key` value is replaced by `***`.
 */
import { createServer } from 'node:http';

const DOI = '10.1101/2024.01.02.123456';

const ESEARCH = { header: { type: 'esearch' }, esearchresult: { count: '2', retmax: '2', idlist: ['111', '222'] } };
const ESUMMARY = {
  result: {
    uids: ['111', '222'],
    111: {
      uid: '111',
      pubdate: '2024 Mar 5',
      source: 'Nat Biotechnol',
      fulljournalname: 'Nature biotechnology',
      title: 'A fake <i>E. coli</i> chassis (test record)',
      authors: [{ name: 'Smith J' }, { name: 'Lee K' }, { name: 'Park Y' }, { name: 'Kim H' }],
      articleids: [{ idtype: 'pubmed', value: '111' }, { idtype: 'doi', value: '10.1038/fake.1' }],
    },
    222: { uid: '222', pubdate: '2023', source: 'Fake J', fulljournalname: '', title: 'Second fake record', authors: [{ name: 'Solo A' }], articleids: [] },
  },
};
const EFETCH = '1. Nature biotechnology. 2024.\n\nA fake E. coli chassis (test record).\n\nAbstract: This abstract comes from the labnoteO fake scholar server.\n';
const EUROPEPMC = {
  hitCount: 1,
  resultList: {
    result: [
      {
        id: '111',
        source: 'MED',
        pmid: '111',
        doi: '10.1038/fake.1',
        title: 'A fake E. coli chassis (test record).',
        authorString: 'Smith J, Lee K, Park Y, Kim H.',
        journalTitle: 'Nat Biotechnol',
        pubYear: '2024',
        abstractText: '<p>This abstract comes from the labnoteO fake scholar server.</p>',
      },
    ],
  },
};
const WORK = {
  DOI: '10.1038/fake.1',
  title: ['A fake E. coli chassis (test record)'],
  'container-title': ['Nature Biotechnology'],
  author: [{ given: 'John', family: 'Smith' }, { given: 'Kim', family: 'Lee' }],
  issued: { 'date-parts': [[2024, 3, 5]] },
  abstract: '<jats:p>This abstract comes from the labnoteO fake scholar server.</jats:p>',
};
const BIORXIV = {
  messages: [{ status: 'ok' }],
  collection: [
    {
      doi: DOI,
      title: 'A fake <i>Bacillus</i> chassis (test preprint)',
      authors: 'Smith, J.; Lee, K. H.',
      date: '2024-02-03',
      version: '1',
      category: 'synthetic biology',
      abstract: 'This preprint comes from the labnoteO fake scholar server.',
    },
  ],
};

function parseArgs(argv) {
  const o = { port: 47831 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0..65535');
  return o;
}

/** The answer for a path under the base, or undefined (404). */
function route(path) {
  if (path === '/pubmed/esearch.fcgi') return { type: 'application/json', body: JSON.stringify(ESEARCH) };
  if (path === '/pubmed/esummary.fcgi') return { type: 'application/json', body: JSON.stringify(ESUMMARY) };
  if (path === '/pubmed/efetch.fcgi') return { type: 'text/plain; charset=utf-8', body: EFETCH };
  if (path === '/europepmc/search') return { type: 'application/json', body: JSON.stringify(EUROPEPMC) };
  if (path === '/crossref/works') return { type: 'application/json', body: JSON.stringify({ status: 'ok', message: { items: [WORK] } }) };
  if (path.startsWith('/crossref/works/')) return { type: 'application/json', body: JSON.stringify({ status: 'ok', message: WORK }) };
  if (path.startsWith('/biorxiv/details/biorxiv/')) return { type: 'application/json', body: JSON.stringify(BIORXIV) };
  return undefined;
}

const opts = parseArgs(process.argv.slice(2));
const log = [];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/__log' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(log));
    return;
  }
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = k === 'api_key' ? '***' : v;
  log.push({ host: req.headers.host ?? '', method: req.method, path: url.pathname, query });
  const hit = req.method === 'GET' ? route(url.pathname) : undefined;
  if (!hit) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'no-store' }).end(hit.body);
});

server.listen(opts.port, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`fake scholar server on http://127.0.0.1:${port}/\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
