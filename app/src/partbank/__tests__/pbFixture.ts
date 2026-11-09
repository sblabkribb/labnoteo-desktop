/**
 * PartBank 테스트가 함께 쓰는 환경(계획의 Shared test fixtures): SP5 의 샘플 환경(`createTestHost` 위의 `createSampleEnv`)에
 * 가짜 invoke(`fakeInvoke`) 위의 `PartbankFeature` 를 더한다. 네트워크도 자격 증명 관리자도 건드리지 않는다:
 * `partbank_request` 는 `routes` 가 답하고, 키가 있는지는 `status` 로 정한다(기본: 웹 연결에 키가 있다).
 */
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { PartbankFeature } from '../../labnote/port/partbankFeature';
import type { PartbankClient } from '../../labnote/port/partbankClient';
import type { AppSettings } from '../../labnote/settings';
import type { InvokeFn, SecretStatus } from '../../integrations/netIpc';
import { fakeInvoke, secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { createSampleEnv, type SampleEnv } from '../../samples/env';
import type { PartbankCatalogStore } from '../catalogOverlay';

export const PB_WEB = 'https://partbank.kbiofoundry.kr';
export const PB_DESKTOP = 'http://127.0.0.1:47830';
/** 가짜 `vault_current` 가 답하는 보관함 뿌리. */
export const PB_VAULT_ROOT = 'C:/vaults/lab';

export interface PbEnv {
  th: TestHost;
  env: SampleEnv;
  feature: PartbankFeature;
  /** `defaultClient()`: 기본 상태에서는 웹 연결. 키가 하나도 없으면 undefined. */
  client: PartbankClient | undefined;
  invoke: InvokeFn;
  /** feature 의 invoke 로 간 커맨드와 인자, 차례대로(보관함 파일 커맨드는 들어 있지 않다). */
  calls: Array<[string, Record<string, unknown>]>;
}

export function pbEnv(
  files: Record<string, string> = {},
  opts: {
    settings?: Partial<AppSettings>;
    routes?: Record<string, (args: Record<string, unknown>) => unknown>;
    status?: SecretStatus;
    /** 앱 데이터의 카탈로그 저장소(D15). 없으면 createSampleEnv 의 기본(지금 저장소). */
    catalogs?: PartbankCatalogStore;
  } = {},
): PbEnv {
  const th = createTestHost(files, {
    partbankWebUrl: PB_WEB,
    partbankDesktopUrl: PB_DESKTOP,
    partbankDefaultConnection: 'web',
    ...opts.settings,
  });
  const status = opts.status ?? secretStatusOf({ partbankWeb: true });
  // vaultGuard() 가 묻는 현재 보관함. 바꾸는 테스트는 routes 로 덮어쓴다.
  const f = fakeInvoke({ secret_status: () => status, vault_current: () => ({ root: PB_VAULT_ROOT }), ...opts.routes });
  const feature = new PartbankFeature({ settings: () => th.ctx.settings, host: th.host, invoke: f.invoke });
  feature.setStatus(status);
  return { th, env: createSampleEnv(th.ctx, { catalogs: opts.catalogs }), feature, client: feature.defaultClient(), invoke: f.invoke, calls: f.calls };
}

/**
 * `partbank_request` 의 경로별 답. `answers` 의 키는 `/api/v1` 뒤의 경로이고, 값은 JSON 몸이거나 던질 값을 돌려주는 함수다.
 * 없는 경로는 404 로 답한다(Rust 처럼 status 오류로 거절).
 */
export function partbankRoutes(
  answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>,
): Record<string, (args: Record<string, unknown>) => unknown> {
  return {
    partbank_request: (args) => {
      const path = String(args.path);
      if (!(path in answers)) throw { kind: 'status', message: 'raw-rust-text', status: 404 };
      const a = answers[path];
      return { status: 200, json: typeof a === 'function' ? (a as (x: Record<string, unknown>) => unknown)(args) : a };
    },
  };
}
