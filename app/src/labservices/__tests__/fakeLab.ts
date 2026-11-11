/**
 * 테스트용 가짜 `LabIpc`: 네트워크 없이 경로마다 정한 답을 준다. 보낸 요청(메서드, 경로, 쿼리, 본문)을 차례로 남긴다.
 * 경로 함수가 던지면 그 값이 거절이 된다. 정하지 않은 경로는 404(`status`)로 거절한다.
 */
import type { ToolContext, ToolDef, ToolResult } from '@labnoteo/core';
import { NetError } from '../../integrations/netIpc';
import type { LabIpc, QueryPairs } from '../ipc';

export interface SentCall {
  method: 'GET' | 'POST';
  service: 'partbank' | 'workflow';
  path: string;
  query?: QueryPairs;
  body?: unknown;
}

type Route = (call: SentCall) => unknown;

export function fakeLab(routes: Record<string, Route | unknown>): { ipc: LabIpc; sent: SentCall[] } {
  const sent: SentCall[] = [];
  const answer = (call: SentCall): unknown => {
    sent.push(call);
    const key = `${call.method} ${call.path}`;
    const r = Object.hasOwn(routes, key) ? routes[key] : Object.hasOwn(routes, call.path) ? routes[call.path] : undefined;
    if (r === undefined) throw new NetError('status', 'raw-rust-text', 404, 'server body text');
    return typeof r === 'function' ? (r as Route)(call) : r;
  };
  const ipc: LabIpc = {
    partbankRead: async (method, path, query, body) => ({
      status: 200,
      json: answer({ method, service: 'partbank', path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) }),
    }),
    bfwRead: async (path, query) => answer({ method: 'GET', service: 'workflow', path, ...(query ? { query } : {}) }),
  };
  return { ipc, sent };
}

export const ctx = {} as ToolContext;

export async function call(tools: ToolDef[], name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools.find((x) => x.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler(ctx, args);
}

/** 울타리 안의 글과 라벨. 울타리가 아니면 던진다. */
export function unfence(text: unknown): { label: string; inner: string } {
  const s = typeof text === 'string' ? text : '';
  const head = /^<untrusted-data source="([^"]+)" id="([0-9a-f]{12})">/.exec(s);
  const close = head ? `</untrusted-data id="${head[2]}">` : '';
  if (!head || !s.endsWith(close)) throw new Error(`not fenced: ${s.slice(0, 200)}`);
  const inner = s.slice(head[0].length, s.length - close.length);
  return { label: head[1], inner: inner.slice(1, -1) };
}

/** 성공한 결과의 JSON(울타리를 벗긴). */
export function dataOf(res: ToolResult): Record<string, unknown> {
  if (!res.ok) throw new Error(`tool failed: ${res.error}`);
  return JSON.parse(unfence(res.data).inner) as Record<string, unknown>;
}

export const oid = (n: number) => `665f${String(n).padStart(20, '0')}`;
