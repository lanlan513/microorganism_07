/**
 * 离线草稿：IndexedDB 持久化
 *
 * 每张正在编辑的卡片（含尚未发布的新卡）保存一条记录：
 *   - ops：本地全部笔画/批注（撤销已从中删除的除外）
 *   - pendingOpIds：尚未确认被服务端接受的 op
 *   - serverVersion / serverOps：最近一次服务端快照
 *
 * 恢复在线后走 syncDraft()：先拉服务端最新版本（别人的笔迹），
 * 再把 pending 的本地操作按版本号重放，409 就合并再试，
 * 全程不会用本地状态覆盖服务端状态。
 */
import {
  mergeClientServer,
  type AppendOp,
  type CardSummary,
  type LogEntry,
} from '../../shared/annotation';
import { ApiError, annotationApi } from './api';

export interface DraftRecord {
  /** 新卡用 local:<random>；已发布卡用服务端 cardId */
  key: string;
  cardId: string | null;
  specimenId: number;
  title: string;
  authorId: string | null;
  ops: AppendOp[];
  pendingOpIds: string[];
  confirmedOpIds: string[];
  /** 本地 undo 掉、需以墓碑形式同步到服务端的已确认 op */
  tombstoneOpIds: string[];
  serverVersion: number;
  serverOps: LogEntry[];
  updatedAt: number;
  forkedFrom?: string | null;
}

const DB_NAME = 'graffiti-db';
const STORE = 'drafts';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export const draftStore = {
  async get(key: string): Promise<DraftRecord | undefined> {
    return tx('readonly', (s) => s.get(key) as IDBRequest<DraftRecord | undefined>);
  },
  async put(draft: DraftRecord): Promise<void> {
    await tx('readwrite', (s) => s.put(draft));
  },
  async delete(key: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(key));
  },
  async list(): Promise<DraftRecord[]> {
    return tx('readonly', (s) => s.getAll() as IDBRequest<DraftRecord[]>);
  },
};

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export interface SyncResult {
  cardId: string;
  serverVersion: number;
  liveOps: LogEntry[];
  /** 还有多少本地操作没能同步（持续离线时非零） */
  pendingLeft: number;
  conflictsResolved: number;
}

/**
 * 合并并同步一张草稿。
 * 关键不变式：服务端快照是权威基线；本地操作永远以"追加"形式提交。
 */
export async function syncDraft(draft: DraftRecord): Promise<{ draft: DraftRecord; result: SyncResult }> {
  if (!draft.cardId) {
    // 尚未发布：创建卡片。本地已 undo 的笔迹直接不带上去
    const dead = new Set(draft.tombstoneOpIds);
    const opsToCreate = draft.ops.filter((o) => !dead.has(o.opId));
    const created = await annotationApi.createCard({
      specimenId: draft.specimenId,
      title: draft.title,
      ops: opsToCreate,
      forkedFrom: draft.forkedFrom ?? undefined,
    });
    const card = created.data;
    const fresh: DraftRecord = {
      ...draft,
      cardId: card.id,
      serverVersion: card.version,
      serverOps: card.liveOps,
      pendingOpIds: [],
      confirmedOpIds: opsToCreate.map((o) => o.opId),
      tombstoneOpIds: [],
      updatedAt: Date.now(),
    };
    await draftStore.put(fresh);
    return { draft: fresh, result: { cardId: card.id, serverVersion: card.version, liveOps: card.liveOps, pendingLeft: 0, conflictsResolved: 0 } };
  }

  // 1) 拉服务端现状（全量详情；生产中可换 delta 减少传输）
  const detail = await annotationApi.getCard(draft.cardId);
  draft.serverOps = detail.data.liveOps;
  draft.serverVersion = detail.data.version;

  // 1b) 先把本地墓碑同步上去（撤回自己已发布的标注）；
  //     服务端快照里已不存在的 op 说明已被撤回/驳回，直接清掉本地待办
  const serverIds = new Set(draft.serverOps.map((o) => o.opId));
  const tombstonesLeft: string[] = [];
  for (const targetOpId of draft.tombstoneOpIds) {
    if (!serverIds.has(targetOpId)) continue; // 服务端已无该笔迹，墓碑无需再发
    try {
      const r = await annotationApi.withdrawOp(draft.cardId, targetOpId);
      draft.serverOps = r.data.liveOps;
      draft.serverVersion = r.data.version;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) continue; // 幂等：已撤回
      if (e instanceof ApiError && e.status === 403) continue; // 非本人笔迹，放弃
      tombstonesLeft.push(targetOpId); // 离线/其他错误：留待下次
    }
  }
  draft.tombstoneOpIds = tombstonesLeft;

  const { pendingLocal } = mergeClientServer(
    draft.serverOps,
    draft.ops,
    new Set([...draft.confirmedOpIds, ...tombstonesLeft]),
  );
  // 待追加的笔迹里若有已被本地撤回的，不能再发
  const deadNow = new Set(draft.tombstoneOpIds);
  const pending = pendingLocal.filter((o) => !deadNow.has(o.opId));

  let conflictsResolved = 0;
  let baseVersion = draft.serverVersion;
  const accepted: string[] = [];

  // 2) 成批重放 pending；409 -> 用冲突响应更新基线 -> 再试
  for (const op of pending) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await annotationApi.append(draft.cardId!, baseVersion, [op]);
        baseVersion = r.data.version;
        draft.serverOps = r.data.liveOps;
        accepted.push(op.opId);
        break;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          conflictsResolved++;
          const body = e.body as { conflict?: { serverVersion: number; liveOps: LogEntry[] } };
          baseVersion = body.conflict?.serverVersion ?? baseVersion;
          if (body.conflict?.liveOps) draft.serverOps = body.conflict.liveOps;
          continue; // 合并后重试同一条本地笔迹
        }
        throw e;
      }
    }
  }

  draft.confirmedOpIds = [...new Set([...draft.confirmedOpIds, ...accepted])];
  draft.pendingOpIds = pending.filter((o) => !accepted.includes(o.opId)).map((o) => o.opId);
  draft.updatedAt = Date.now();
  await draftStore.put(draft);

  return {
    draft,
    result: {
      cardId: draft.cardId,
      serverVersion: baseVersion,
      liveOps: draft.serverOps,
      pendingLeft: draft.pendingOpIds.length + draft.tombstoneOpIds.length,
      conflictsResolved,
    },
  };
}

/** 把一张已存在卡片的最新状态同步进草稿（不做提交），用于打开页面时合并 */
export async function refreshDraftFromServer(draft: DraftRecord): Promise<DraftRecord> {
  if (!draft.cardId) return draft;
  const detail = await annotationApi.getCard(draft.cardId);
  draft.serverOps = detail.data.liveOps;
  draft.serverVersion = detail.data.version;
  draft.updatedAt = Date.now();
  await draftStore.put(draft);
  return draft;
}

/** 合并视图：渲染层只看这个（服务端笔迹 + 未确认的本地尾巴，再滤掉本地墓碑） */
export function draftLiveOps(draft: DraftRecord): LogEntry[] {
  const { liveOps } = mergeClientServer(draft.serverOps, draft.ops, new Set(draft.confirmedOpIds));
  if (draft.tombstoneOpIds.length === 0) return liveOps;
  const dead = new Set(draft.tombstoneOpIds);
  return liveOps.filter((o) => !dead.has(o.opId));
}

export type { CardSummary };
