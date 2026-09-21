import type {
  AnnotationCard,
  AnnotationOp,
  CardEvent,
  CardSummary,
  CardStatus,
  CommitResult,
} from '../../shared/annotations';
import { LIMITS } from '../../shared/annotations';
import { getIdentity } from './identity';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface CreateCardPayload {
  specimenId: number;
  title: string;
  note: string;
  ops: AnnotationOp[];
}

export interface CardDetail {
  card: CardSummary;
  status: CardStatus;
  note: string;
  events: CardEvent[];
  forkedFrom: string | null;
}

/** 当压缩后反而更小时自动发 gzip；服务端按 Content-Encoding 解压 */
async function postRaw(path: string, body: unknown): Promise<unknown> {
  const identity = getIdentity();
  const json = new TextEncoder().encode(JSON.stringify(body));
  let buf: BufferSource = json;
  const headers: Record<string, string> = {
    'X-User-Id': identity.id,
    'X-User-Name': encodeURIComponent(identity.name),
  };
  // 超过 32KB 才尝试压缩（小数据压缩不划算），超大笔迹数据体积上限的客户端一环
  if (json.length > 32 * 1024 && typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([json]).stream().pipeThrough(cs);
    const gz = new Uint8Array(await new Response(stream).arrayBuffer());
    if (gz.length < json.length * 0.95) {
      buf = gz;
      headers['Content-Encoding'] = 'gzip';
    }
  }
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers,
    body: buf as BodyInit,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new ApiError(res.status, data.code || 'ERROR', data.error || `请求失败 (${res.status})`);
  }
  return data.data;
}

function getHeaders(): Record<string, string> {
  const identity = getIdentity();
  return { 'X-User-Id': identity.id, 'X-User-Name': encodeURIComponent(identity.name) };
}

async function getJson(path: string, modToken?: string): Promise<unknown> {
  const headers = getHeaders();
  if (modToken) headers['X-Mod-Token'] = modToken;
  const res = await fetch(`/api${path}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new ApiError(res.status, data.code || 'ERROR', data.error || `请求失败 (${res.status})`);
  }
  return data.data;
}

export const annotationApi = {
  listCorridor: async (specimenId?: number): Promise<CardSummary[]> => {
    const q = specimenId !== undefined ? `?specimenId=${specimenId}` : '';
    return (await getJson(`/cards${q}`)) as CardSummary[];
  },

  listMine: async (): Promise<CardSummary[]> => (await getJson('/cards?mine=1')) as CardSummary[],

  getCard: async (id: string, since?: number): Promise<CardDetail> => {
    const q = since !== undefined ? `?since=${since}` : '';
    return (await getJson(`/cards/${id}${q}`)) as CardDetail;
  },

  createCard: async (payload: CreateCardPayload): Promise<{ card: CardSummary; commit: CommitResult }> => {
    if (JSON.stringify(payload.ops).length > LIMITS.MAX_JSON_BYTES) {
      throw new ApiError(413, 'CLIENT_TOO_LARGE', '笔迹数据超过 1MB，请减少单次提交的笔迹数');
    }
    return (await postRaw('/cards', payload)) as { card: CardSummary; commit: CommitResult };
  },

  /**
   * 追加批注。返回 events = baseVersion 之后的全部事件，
   * 里面同时包含自己这批和并发对方那批笔迹。
   */
  commit: async (cardId: string, baseVersion: number, ops: AnnotationOp[]): Promise<CommitResult> => {
    if (JSON.stringify(ops).length > LIMITS.MAX_JSON_BYTES) {
      throw new ApiError(413, 'CLIENT_TOO_LARGE', '笔迹数据超过 1MB，请分批提交');
    }
    return (await postRaw(`/cards/${cardId}/commits`, { baseVersion, ops })) as CommitResult;
  },

  publish: async (cardId: string) => postRaw(`/cards/${cardId}/publish`, {}),
  retract: async (cardId: string) => postRaw(`/cards/${cardId}/retract`, {}),
  retractOp: async (cardId: string, opId: string) => postRaw(`/cards/${cardId}/ops/${opId}/retract`, {}),
  fork: async (cardId: string): Promise<{ id: string }> =>
    (await postRaw(`/cards/${cardId}/fork`, {})) as { id: string },
  like: async (cardId: string): Promise<{ likeCount: number; liked: boolean }> =>
    (await postRaw(`/cards/${cardId}/like`, {})) as { likeCount: number; liked: boolean },

  modQueue: async (token: string): Promise<CardSummary[]> =>
    (await getJson('/moderation/queue', token)) as CardSummary[],
  modDecide: async (token: string, cardId: string, decision: 'approved' | 'rejected', reason?: string) => {
    const identity = getIdentity();
    const res = await fetch(`/api/moderation/cards/${cardId}`, {
      method: 'POST',
      headers: { 'X-Mod-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, reason }),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new ApiError(res.status, data.code, data.error);
    }
    void identity;
    return data.data;
  },
  modHideOp: async (token: string, cardId: string, opId: string) => {
    const res = await fetch(`/api/moderation/cards/${cardId}/ops/${opId}/hide`, {
      method: 'POST',
      headers: { 'X-Mod-Token': token },
    });
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data.code, data.error);
    return data.data;
  },
};

export type { AnnotationCard };
