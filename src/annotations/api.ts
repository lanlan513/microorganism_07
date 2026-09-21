/**
 * 涂鸦共享馆前端 API 客户端
 * - 身份：localStorage 里的长期随机 ID（演示用）
 * - 所有写操作带身份头；审核动作额外带审核员密钥
 */
import {
  LIMITS,
  type AppendOp,
  type CardDetail,
  type CardSummary,
  type LogEntry,
} from '../../shared/annotation';

const BASE = '/api/annotations';

export interface Identity {
  userId: string;
  userName: string;
}

const ID_KEY = 'graffiti.identity.v1';

function rid(): string {
  return 'u-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
}

export function getIdentity(): Identity {
  try {
    const raw = localStorage.getItem(ID_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Identity;
      if (p.userId && /^[a-zA-Z0-9_-]{6,64}$/.test(p.userId)) return p;
    }
  } catch {
    /* ignore */
  }
  const id: Identity = { userId: rid(), userName: `研究员${Math.floor(Math.random() * 9000 + 1000)}` };
  localStorage.setItem(ID_KEY, JSON.stringify(id));
  return id;
}

export function setUserName(name: string) {
  const id = getIdentity();
  id.userName = name.slice(0, 32) || id.userName;
  localStorage.setItem(ID_KEY, JSON.stringify(id));
}

export function isModeratorMode(): boolean {
  return localStorage.getItem('graffiti.moderator') === '1';
}
export function setModeratorMode(on: boolean, key = '') {
  if (on) {
    localStorage.setItem('graffiti.moderator', '1');
    localStorage.setItem('graffiti.mod-key', key);
  } else {
    localStorage.removeItem('graffiti.moderator');
    localStorage.removeItem('graffiti.mod-key');
  }
}
function modKey(): string {
  return localStorage.getItem('graffiti.mod-key') || 'demo-mod-key';
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const identity = getIdentity();
  const headers = new Headers(init.headers);
  headers.set('x-user-id', identity.userId);
  headers.set('x-user-name', encodeURIComponent(identity.userName));
  if (isModeratorMode()) headers.set('x-moderator-key', modKey());
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  const envelope = data as { success?: boolean; error?: string };
  if (!res.ok || envelope?.success === false) {
    throw new ApiError(res.status, envelope?.error || `请求失败 (${res.status})`, data);
  }
  return { status: res.status, data: (data as { data: T }).data };
}

export interface ConflictBody {
  conflict: { serverVersion: number; liveOps: LogEntry[]; missingOps: string[] };
}

export interface FeedResult {
  total: number;
  items: CardSummary[];
}

export const annotationApi = {
  listCards: (params: { specimenId?: number; status?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.specimenId) q.set('specimenId', String(params.specimenId));
    if (params.status) q.set('status', params.status);
    q.set('limit', String(params.limit ?? 24));
    q.set('offset', String(params.offset ?? 0));
    return request<FeedResult>(`/cards?${q}`);
  },

  getCard: (id: string) => request<CardDetail>(`/cards/${id}`),

  delta: (id: string, since: number) =>
    request<{ version: number; status: string; entries: LogEntry[] }>(
      `/cards/${id}/delta?since=${since}`,
    ),

  createCard: (input: { specimenId: number; title: string; ops: AppendOp[]; forkedFrom?: string }) =>
    request<CardDetail>('/cards', { method: 'POST', body: JSON.stringify(input) }),

  append: (cardId: string, baseVersion: number, ops: AppendOp[]) =>
    request<CardDetail>(`/cards/${cardId}/append`, {
      method: 'POST',
      body: JSON.stringify({ baseVersion, ops }),
    }),

  like: (cardId: string, liked: boolean) =>
    request<{ likeCount: number; likedByMe: boolean }>(`/cards/${cardId}/like`, {
      method: 'POST',
      body: JSON.stringify({ liked }),
    }),

  fork: (cardId: string) => request<CardDetail>(`/cards/${cardId}/fork`, { method: 'POST' }),

  withdrawOp: (cardId: string, opId: string) =>
    request<CardDetail>(`/cards/${cardId}/withdraw-op`, { method: 'POST', body: JSON.stringify({ opId }) }),

  withdrawCard: (cardId: string) =>
    request<{ status: string }>(`/cards/${cardId}`, { method: 'DELETE' }),

  moderate: (cardId: string, decision: 'approved' | 'rejected', reviewNote = '') =>
    request<CardDetail>(`/moderation/cards/${cardId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, reviewNote }),
    }),

  moderationQueue: () => request<FeedResult>(`/moderation/queue?limit=50`),
};

export { LIMITS };
