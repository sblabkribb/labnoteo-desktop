import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import type {
  Account,
  FolderStatus,
  GithubProgress,
  PlanOutcome,
  PlanTarget,
  UploadChoices,
  UploadOutcome,
} from '../../integrations/githubIpc';
import type { CommandContext } from '../../labnote/commands/context';
import { fitsQuick, uploadExperiment, type FlowDeps, type FlowUi, type ReadyPlan } from '../githubFlow';
import type { Destination, DestinationInit } from '../UploadDialog';
import { LinkIndex } from '../../links/linkIndex';
import { collectInfoWith } from '../collectInfo';

const FOLDER = 'labnote/001_단백질_발현';
const ME: Account = { login: 'parkyaeseong', id: 1, avatarUrl: '' };
const ctx = {} as CommandContext;

beforeEach(() => setLang('ko'));

function ready(over: Partial<ReadyPlan> = {}): ReadyPlan {
  return {
    outcome: 'ready',
    planId: 'p1',
    mode: 'first',
    files: [{ path: `${FOLDER}/README.labnote.md`, size: 10, change: 'new' }],
    excluded: [],
    red: [],
    yellow: [],
    samples: [],
    totals: { files: 1, generated: 0, bytes: 10, excluded: 0, new: 1, changed: 0, deleted: 0 },
    quickOk: false,
    ...over,
  };
}

const DONE: UploadOutcome = {
  outcome: 'done',
  htmlUrl: 'https://github.com/parkyaeseong/001_danbaekjil_balhyeon',
  fullName: 'parkyaeseong/001_danbaekjil_balhyeon',
  counts: { new: 1, changed: 0, deleted: 0 },
  warnings: [],
};

interface Harness {
  deps: FlowDeps;
  calls: string[];
  plans: Array<{ target: PlanTarget; infoFindings: unknown[] }>;
  uploads: UploadChoices[];
  notes: Array<{ kind: string; message: string; opts?: unknown }>;
  destinations: DestinationInit[];
  chooses: Array<{ message: string; labels: string[] }>;
  opened: string[];
  quickPlans: ReadyPlan[];
  progressLines: string[];
  cancellable: boolean[];
  done: unknown[];
  settings: unknown[];
}

function harness(o: {
  account?: Account | null;
  status?: Partial<FolderStatus>;
  plans?: PlanOutcome[];
  outcomes?: UploadOutcome[];
  signIn?: Array<'ok' | 'cancel' | 'useToken'>;
  destination?: Array<Destination | 'cancel'>;
  preview?: Array<UploadChoices | 'cancel'>;
  quick?: Array<'upload' | 'details' | 'cancel'>;
  diverged?: Array<{ mode: 'mine' | 'separate'; ack: string[] } | 'cancel'>;
  choose?: unknown[];
  progress?: GithubProgress[];
  info?: { sampleIds: string[]; infoFindings: never[] | Array<{ kind: 'outside'; paths: string[] }>; title: string };
}): Harness {
  const h: Harness = {
    deps: undefined as unknown as FlowDeps,
    calls: [],
    plans: [],
    uploads: [],
    notes: [],
    destinations: [],
    chooses: [],
    opened: [],
    quickPlans: [],
    progressLines: [],
    cancellable: [],
    done: [],
    settings: [],
  };
  let account = o.account === undefined ? ME : o.account;
  const plans = [...(o.plans ?? [ready()])];
  const outcomes = [...(o.outcomes ?? [DONE])];
  const signIns = [...(o.signIn ?? ['ok'])];
  const dests = [...(o.destination ?? [{ kind: 'create', owner: ME.login, name: '001_danbaekjil_balhyeon', private: true }])];
  const previews = [...(o.preview ?? [{}])];
  const quicks = [...(o.quick ?? ['upload'])];
  const divs = [...(o.diverged ?? [])];
  const chooses = [...(o.choose ?? [])];
  let listener: ((e: GithubProgress) => void) | undefined;
  const ui: FlowUi = {
    signIn: async () => {
      h.calls.push('signIn');
      const r = signIns.shift() ?? 'cancel';
      if (r === 'ok') account = ME;
      return r;
    },
    destination: async (init) => {
      h.calls.push('destination');
      h.destinations.push(init);
      return dests.shift() ?? 'cancel';
    },
    preview: async () => {
      h.calls.push('preview');
      return previews.shift() ?? 'cancel';
    },
    quick: async (plan) => {
      h.calls.push('quick');
      h.quickPlans.push(plan);
      return quicks.shift() ?? 'cancel';
    },
    diverged: async () => {
      h.calls.push('diverged');
      return divs.shift() ?? 'cancel';
    },
    progress: () => ({
      signal: new AbortController().signal,
      line: (s) => void h.progressLines.push(s),
      done: () => undefined,
      setCancellable: (v) => void h.cancellable.push(v),
    }),
    notify: (kind, message, opts) => void h.notes.push({ kind, message, opts }),
    choose: async <T,>(message: string, choices: readonly { label: string; value: T }[]) => {
      h.calls.push('choose');
      h.chooses.push({ message, labels: choices.map((c) => c.label) });
      return chooses.shift() as T | undefined;
    },
    done: async (r) => {
      h.calls.push('done');
      h.done.push(r);
    },
    openExternal: (url) => void h.opened.push(url),
    openSettings: (page, opts) => void h.settings.push({ page, opts }),
  };
  h.deps = {
    ui,
    rand: () => 'abcd',
    today: () => new Date(2026, 10, 10),
    collectInfo: async () => o.info ?? { sampleIds: [], infoFindings: [], title: '단백질 발현' },
    ipc: {
      githubAccount: async () => account,
      githubSignOut: async () => {
        account = null;
      },
      githubFolderStatus: async () => ({ linked: false, state: 'planned', changedCount: 0, folderMissing: false, ...o.status }),
      githubDefaultOwnerGet: async () => null,
      githubPlan: async (a) => {
        h.calls.push('plan');
        h.plans.push({ target: a.target, infoFindings: a.infoFindings });
        return (plans.length > 1 ? plans.shift() : plans[0]) ?? ready();
      },
      githubUpload: async (a) => {
        h.calls.push('upload');
        h.uploads.push(a.choices);
        for (const e of o.progress ?? []) listener?.({ ...e, requestId: a.requestId! });
        return outcomes.shift() ?? DONE;
      },
      onGithubProgress: async (cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
    },
  };
  return h;
}

const LINKED: Partial<FolderStatus> = { linked: true, state: 'pushed', fullName: 'parkyaeseong/x', htmlUrl: 'https://github.com/parkyaeseong/x', private: true };

describe('uploadExperiment', () => {
  it('unlinked + no account: sign in → destination → plan → preview → upload → done with the title and full name', async () => {
    const h = harness({ account: null });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['signIn', 'destination', 'plan', 'preview', 'upload', 'done']);
    expect(h.destinations[0]).toMatchObject({ title: '단백질 발현', folderName: '001_단백질_발현', slug: '001_danbaekjil_balhyeon', account: ME });
    expect(h.plans[0].target).toEqual({ kind: 'create', owner: ME.login, name: '001_danbaekjil_balhyeon', private: true });
    expect(h.done).toEqual([{ title: '단백질 발현', fullName: DONE.outcome === 'done' ? DONE.fullName : '', htmlUrl: DONE.outcome === 'done' ? DONE.htmlUrl : '' }]);
    expect(h.cancellable).toEqual([false]);
  });

  it('"connect with a token" ends the flow and opens the integrations settings at the token field', async () => {
    const h = harness({ account: null, signIn: ['useToken'] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['signIn']);
    expect(h.settings).toEqual([{ page: 'integrations', opts: { focus: 'githubToken' } }]);
  });

  it('a cancelled destination plans nothing', async () => {
    const h = harness({ destination: ['cancel'] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['destination']);
  });

  it('a public destination sends the typed name as publicConfirm', async () => {
    const h = harness({ destination: [{ kind: 'create', owner: ME.login, name: 'r', private: false, publicConfirm: 'r' }] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.plans[0].target).toEqual({ kind: 'create', owner: ME.login, name: 'r', private: false });
    expect(h.uploads[0]).toEqual({ publicConfirm: 'r' });
  });

  it('linked + quickOk: no dialog, a toast with done.changes and an open action', async () => {
    const h = harness({
      status: LINKED,
      plans: [ready({ mode: 'update', quickOk: true })],
      outcomes: [{ ...DONE, counts: { new: 0, changed: 3, deleted: 0 } } as UploadOutcome],
    });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['plan', 'upload']);
    expect(h.plans[0].target).toEqual({ kind: 'update' });
    expect(h.notes[0].message).toBe(t('github.done.changes', 0, 3, 0, '단백질 발현'));
    (h.notes[0].opts as { action: { run(): void } }).action.run();
    expect(h.opened).toEqual([DONE.outcome === 'done' ? DONE.htmlUrl : '']);
  });

  it('nothing changed gives done.nothing', async () => {
    const h = harness({ status: LINKED, plans: [ready({ mode: 'update', quickOk: true })], outcomes: [{ outcome: 'nothingChanged' }] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.notes.map((n) => n.message)).toEqual([t('github.done.nothing')]);
  });

  it('new files: the quick confirm is shown with the plan naming them', async () => {
    const plan = ready({
      mode: 'update',
      files: [
        { path: `${FOLDER}/images/gel2.png`, size: 5, change: 'new' },
        { path: `${FOLDER}/old.csv`, size: 0, change: 'deleted' },
      ],
      totals: { files: 1, generated: 0, bytes: 5, excluded: 0, new: 1, changed: 0, deleted: 1 },
    });
    expect(fitsQuick(plan)).toBe(true);
    const h = harness({ status: LINKED, plans: [plan], quick: ['upload'] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['plan', 'quick', 'upload']);
    expect(h.quickPlans[0].files.map((f) => f.path)).toEqual([`${FOLDER}/images/gel2.png`, `${FOLDER}/old.csv`]);
  });

  it('"show details" on the quick confirm opens the full preview', async () => {
    const plan = ready({ mode: 'update', totals: { files: 1, generated: 0, bytes: 5, excluded: 0, new: 1, changed: 0, deleted: 0 } });
    const h = harness({ status: LINKED, plans: [plan], quick: ['details'], preview: [{ untick: [] }] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['plan', 'quick', 'preview', 'upload']);
  });

  it('a red finding shows the full preview, and cancelling it uploads nothing', async () => {
    const plan = ready({
      mode: 'update',
      red: [{ kind: 'tooLarge', path: `${FOLDER}/gel_raw.czi`, size: 312_000_000 }],
      totals: { files: 1, generated: 0, bytes: 5, excluded: 0, new: 1, changed: 0, deleted: 0 },
    });
    expect(fitsQuick(plan)).toBe(false);
    const h = harness({ status: LINKED, plans: [plan], preview: ['cancel'] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['plan', 'preview']);
  });

  it('needsSignIn: exactly one sign-in and one re-plan, no loop on a second needsSignIn', async () => {
    const h = harness({ status: LINKED, plans: [ready({ mode: 'update', quickOk: true })], outcomes: [{ outcome: 'needsSignIn' }, { outcome: 'needsSignIn' }] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['plan', 'upload', 'signIn', 'plan', 'upload']);
    expect(h.notes.map((n) => n.message)).toEqual([t('github.err.needsSignIn')]);
  });

  it('diverged: the dialog, then the same plan again with diverged "mine" and the ack list', async () => {
    const h = harness({
      status: LINKED,
      plans: [ready({ mode: 'update', quickOk: true })],
      outcomes: [
        { outcome: 'diverged', files: [{ path: 'README.labnote.md', change: 'changed', goneHere: false }], warnings: [] },
        { ...DONE, counts: { new: 0, changed: 1, deleted: 0 } } as UploadOutcome,
      ],
      diverged: [{ mode: 'mine', ack: ['README.labnote.md'] }],
    });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['plan', 'upload', 'diverged', 'upload']);
    expect(h.uploads[1]).toEqual({ diverged: 'mine', ackFiles: ['README.labnote.md'] });
  });

  it('orgRestricted: three ways out; "upload to my account" reopens the destination with me as the owner', async () => {
    const h = harness({
      destination: [
        { kind: 'create', owner: 'kim-lab', name: 'parkyaeseong-x', private: true },
        { kind: 'create', owner: ME.login, name: 'x', private: true },
      ],
      outcomes: [{ outcome: 'orgRestricted', org: 'kim-lab', approveUrl: 'https://github.com/settings/connections/applications/abc' }, DONE],
      preview: [{}, {}],
      choose: ['mine'],
    });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.chooses[0].labels).toHaveLength(3);
    expect(h.chooses[0].labels[0]).toBe(t('github.err.orgMine'));
    expect(h.destinations[1].owner).toBe(ME.login);
    expect(h.plans[1].target).toEqual({ kind: 'create', owner: ME.login, name: 'x', private: true });
    expect(h.calls.at(-1)).toBe('done');
  });

  it('orgRestricted: "request approval" opens the approval page and stops', async () => {
    const h = harness({ outcomes: [{ outcome: 'orgRestricted', org: 'kim-lab', approveUrl: 'https://github.com/orgs/kim-lab/policies' }], choose: ['request'] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.opened).toEqual(['https://github.com/orgs/kim-lab/policies']);
    expect(h.calls.filter((c) => c === 'upload')).toHaveLength(1);
  });

  it('rateLimited{120} says 2 minutes and does not retry', async () => {
    setLang('ko');
    const h = harness({ outcomes: [{ outcome: 'rateLimited', seconds: 120 }] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.notes.map((n) => n.message)).toEqual([t('github.err.rateLimited', 2)]);
    expect(h.notes[0].message).toContain('2분');
    expect(h.calls.filter((c) => c === 'upload')).toHaveLength(1);
  });

  it('visibilityMismatch: an error dialog with "open on GitHub", no retry', async () => {
    const h = harness({ outcomes: [{ outcome: 'visibilityMismatch', htmlUrl: 'https://github.com/parkyaeseong/x' }], choose: [true] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.chooses).toEqual([{ message: t('github.err.visibilityMismatch'), labels: [t('github.menu.open')] }]);
    expect(h.opened).toEqual(['https://github.com/parkyaeseong/x']);
    expect(h.calls.filter((c) => c === 'upload')).toHaveLength(1);
  });

  it('busy gives err.busy and no retry', async () => {
    const h = harness({ outcomes: [{ outcome: 'busy' }] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.notes).toEqual([{ kind: 'warn', message: t('github.err.busy'), opts: undefined }]);
    expect(h.calls.filter((c) => c === 'upload')).toHaveLength(1);
  });

  it('planStale re-plans once with a notice; a second planStale stops', async () => {
    const h = harness({ outcomes: [{ outcome: 'planStale' }, { outcome: 'planStale' }], preview: [{}, {}] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.calls).toEqual(['destination', 'plan', 'preview', 'upload', 'plan', 'preview', 'upload']);
    expect(h.notes.map((n) => n.kind)).toEqual(['info', 'error']);
    expect(h.plans[1].target).toEqual(h.plans[0].target);
  });

  it('the progress window is locked and shows the steps once each', async () => {
    const h = harness({
      progress: [
        { requestId: '', stage: 'creating', done: 0, total: 1 },
        { requestId: '', stage: 'preparing', done: 0, total: 1 },
        { requestId: '', stage: 'uploading', done: 10, total: 2048 },
        { requestId: '', stage: 'uploading', done: 1024, total: 2048 },
        { requestId: '', stage: 'uploading', done: 2048, total: 2048 },
        { requestId: '', stage: 'checking', done: 0, total: 1 },
      ],
    });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.progressLines).toEqual([
      t('github.progress.creating'),
      t('github.progress.preparing'),
      t('github.progress.noCancel'),
      t('github.progress.uploading', '10 B', '2 KB'),
      t('github.progress.uploading', '2 KB', '2 KB'),
      t('github.progress.checking'),
    ]);
  });

  it('a re-upload passes no info findings; a first upload passes them', async () => {
    const info = { sampleIds: ['dna-1'], infoFindings: [{ kind: 'outside' as const, paths: ['resources/a.png'] }], title: 'x' };
    const first = harness({ info });
    await uploadExperiment(ctx, FOLDER, first.deps);
    expect(first.plans[0].infoFindings).toEqual(info.infoFindings);
    const again = harness({ info, status: LINKED, plans: [ready({ mode: 'update', quickOk: true })] });
    await uploadExperiment(ctx, FOLDER, again.deps);
    expect(again.plans[0].infoFindings).toEqual([]);
  });
});

describe('collectInfo', () => {
  const README = [
    '---',
    'title: 단백질 발현',
    'author: 홍길동',
    '---',
    '# 실험',
    '![[plasmid_map.png]]',
    '[[002_다른실험/README.labnote]]',
    '![[gel.png]]',
    '',
  ].join('\n');

  function index(): LinkIndex {
    const ix = new LinkIndex();
    ix.setFiles([
      `${FOLDER}/README.labnote.md`,
      `${FOLDER}/images/gel.png`,
      `${FOLDER}/images/unused.png`,
      'resources/plasmid_map.png',
      'labnote/002_다른실험/README.labnote.md',
    ]);
    ix.setNote(`${FOLDER}/README.labnote.md`, README);
    ix.markReady();
    return ix;
  }

  it('finds an image embedded from vault-level resources/ as outside, plus links, unused pictures, title and author', async () => {
    const ix = index();
    const info = await collectInfoWith(FOLDER, {
      files: ix.files(),
      read: async (p) => (p === `${FOLDER}/README.labnote.md` ? README : ''),
      resolved: (p) => ix.resolved(p),
      sampleTypes: [],
    });
    expect(info.title).toBe('단백질 발현');
    expect(info.infoFindings).toEqual([
      { kind: 'author', names: ['홍길동'] },
      { kind: 'crossLinks', count: 1 },
      { kind: 'wikiLinks', count: 3 },
      { kind: 'outside', count: 1, paths: ['resources/plasmid_map.png'] },
      { kind: 'unused', count: 1, paths: [`${FOLDER}/images/unused.png`] },
    ]);
  });

  it('the outside paths reach githubPlan as an outside info finding', async () => {
    const ix = index();
    const h = harness({});
    h.deps.collectInfo = (folder) =>
      collectInfoWith(folder, { files: ix.files(), read: async () => README, resolved: (p) => ix.resolved(p), sampleTypes: [] });
    await uploadExperiment(ctx, FOLDER, h.deps);
    expect(h.plans[0].infoFindings).toContainEqual({ kind: 'outside', count: 1, paths: ['resources/plasmid_map.png'] });
  });
});
