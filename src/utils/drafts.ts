import type { AnnotationOp } from '../../shared/annotations';

/**
 * 离线草稿：断网时笔迹/讲解先落到 localStorage。
 * 恢复联网后，Studio 的同步流程是：
 *   1) GET /cards/:id?since=baseVersion 拉别人新增的笔迹并合并；
 *   2) 再把 pendingOps 以「最新版本号」为 base 提交；
 *   3) 服务端幂等去重 → 绝不冲掉别人的笔迹。
 * 新卡片在发布前一直是本地草稿，创建时整包带上 pendingOps。
 */

export interface Draft {
  cardId: string | null; // null = 尚未在服务端创建
  specimenId: number;
  title: string;
  note: string;
  forkedFrom: string | null;
  baseVersion: number;
  /** 已经同步到服务端的笔迹快照（用于恢复画布） */
  serverOps: AnnotationOp[];
  /** 本地未提交笔迹（离线队列） */
  pendingOps: AnnotationOp[];
  updatedAt: number;
}

const PREFIX = 'annotation-draft:';

export function draftKey(specimenId: number, cardId: string | null): string {
  return PREFIX + (cardId ?? `new-${specimenId}`);
}

export function saveDraft(d: Draft): void {
  try {
    localStorage.setItem(draftKey(d.specimenId, d.cardId), JSON.stringify(d));
  } catch (err) {
    // localStorage 配额耗尽（大笔迹）：提示用户，但不丢已同步内容
    console.warn('草稿保存失败', err);
  }
}

export function loadDraft(specimenId: number, cardId: string | null): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(specimenId, cardId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

export function clearDraft(specimenId: number, cardId: string | null): void {
  localStorage.removeItem(draftKey(specimenId, cardId));
}

export function listDrafts(): Draft[] {
  const out: Draft[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) {
      try {
        out.push(JSON.parse(localStorage.getItem(k) || '{}') as Draft);
      } catch {
        /* ignore */
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
