/**
 * 涂鸦共享馆路由
 *
 * 身份模型（演示用，无注册系统）：
 *   x-user-id / x-user-name 由浏览器生成并长期保存在 localStorage。
 *   审核员：x-moderator-key 与环境变量 MODERATOR_KEY 匹配（默认 demo-mod-key）。
 */
import { Router, type Request, type Response } from 'express';
import { LIMITS } from '../../../shared/annotation.js';
import { AnnotationStore } from './store.js';

export interface Identity {
  userId: string;
  userName: string;
}

function getIdentity(req: Request): Identity | null {
  const userId = req.header('x-user-id');
  if (!userId || !/^[a-zA-Z0-9_-]{6,64}$/.test(userId)) return null;
  const userName = (req.header('x-user-name') || '匿名研究员').slice(0, 32);
  return { userId, userName };
}

function requireAuth(req: Request, res: Response): Identity | null {
  const id = getIdentity(req);
  if (!id) {
    res.status(401).json({ success: false, error: '缺少有效身份（x-user-id）' });
    return null;
  }
  return id;
}

function isModerator(req: Request): boolean {
  const key = process.env.MODERATOR_KEY || 'demo-mod-key';
  return req.header('x-moderator-key') === key;
}

function parseListParams(req: Request) {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? 20), 10) || 20));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? 0), 10) || 0);
  const specimenIdRaw = req.query.specimenId ? parseInt(String(req.query.specimenId), 10) : undefined;
  const specimenId = Number.isInteger(specimenIdRaw) ? specimenIdRaw : undefined;
  return { limit, offset, specimenId };
}

export function createAnnotationRouter(store: AnnotationStore): Router {
  const router = Router();

  // 公共走廊：列表默认只看 approved（审核状态过滤）
  router.get('/cards', (req, res) => {
    const identity = getIdentity(req);
    const { limit, offset, specimenId } = parseListParams(req);
    const statusParam = String(req.query.status ?? 'approved') as
      | 'approved'
      | 'pending'
      | 'rejected'
      | 'withdrawn'
      | 'mine'
      | 'all';

    if (statusParam === 'pending' || statusParam === 'rejected' || statusParam === 'all') {
      if (!isModerator(req)) {
        res.status(403).json({ success: false, error: '该审核状态队列仅审核员可见' });
        return;
      }
    }

    if (statusParam === 'mine') {
      if (!identity) {
        res.status(401).json({ success: false, error: '查看我的卡片需要身份' });
        return;
      }
      const feed = store.listByAuthor(identity.userId, limit, offset);
      res.json({ success: true, data: feed });
      return;
    }

    const status = ['approved', 'pending', 'rejected', 'withdrawn'].includes(statusParam)
      ? (statusParam as 'approved' | 'pending' | 'rejected' | 'withdrawn')
      : 'approved';
    const feed = store.listFeed({ specimenId, status, viewerId: identity?.userId ?? null, limit, offset });
    res.json({ success: true, data: feed });
  });

  // 卡片详情：pending/rejected 仅作者本人或审核员可见
  router.get('/cards/:id', (req, res) => {
    const identity = getIdentity(req);
    const card = store.getCard(req.params.id, identity?.userId ?? null);
    if (!card) {
      res.status(404).json({ success: false, error: '卡片不存在' });
      return;
    }
    if (card.status !== 'approved' && card.status !== 'withdrawn') {
      const allowed = identity && (card.authorId === identity.userId || isModerator(req));
      if (!allowed) {
        res.status(403).json({ success: false, error: '该卡片尚未通过审核' });
        return;
      }
    }
    if (card.status === 'withdrawn') {
      const allowed = identity && (card.authorId === identity.userId || isModerator(req));
      if (!allowed) {
        res.status(404).json({ success: false, error: '卡片已被作者撤回' });
        return;
      }
    }
    res.json({ success: true, data: card });
  });

  // 增量同步（可见性与卡片详情一致，防止 pending 内容从 delta 泄露）
  router.get('/cards/:id/delta', (req, res) => {
    const identity = getIdentity(req);
    const card = store.getCard(req.params.id, identity?.userId ?? null);
    if (!card) {
      res.status(404).json({ success: false, error: '卡片不存在' });
      return;
    }
    if (card.status !== 'approved') {
      const allowed = identity && (card.authorId === identity.userId || isModerator(req));
      if (!allowed) {
        res.status(403).json({ success: false, error: '该卡片未公开发布' });
        return;
      }
    }
    const since = parseInt(String(req.query.since ?? 0), 10);
    if (!Number.isInteger(since) || since < 0) {
      res.status(400).json({ success: false, error: 'since 必须是非负整数' });
      return;
    }
    const delta = store.getDelta(req.params.id, since);
    if (!delta) {
      res.status(404).json({ success: false, error: '卡片不存在' });
      return;
    }
    res.json({ success: true, data: delta });
  });

  // 创建讲解卡片
  router.post('/cards', (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const { specimenId, title, ops, forkedFrom } = req.body ?? {};
    const result = store.createCard({
      specimenId,
      title: title ?? '',
      userId: identity.userId,
      userName: identity.userName,
      ops: Array.isArray(ops) ? ops : [],
      forkedFrom: forkedFrom ?? null,
      autoApprove: process.env.AUTO_APPROVE === '1',
    });
    if (result.error) {
      res.status(result.status ?? 400).json({ success: false, error: result.error });
      return;
    }
    res.status(201).json({
      success: true,
      data: result.card,
      meta: { reviewHint: process.env.AUTO_APPROVE === '1' ? 'auto-approved' : 'pending-moderation' },
    });
  });

  // 追加批注（带版本号的乐观并发）
  router.post('/cards/:id/append', (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const baseVersion = parseInt(String(req.body?.baseVersion), 10);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      res.status(400).json({ success: false, error: 'baseVersion 必须是非负整数' });
      return;
    }
    const result = store.appendOps(
      req.params.id,
      baseVersion,
      Array.isArray(req.body?.ops) ? req.body.ops : [],
      identity.userId,
    );
    if (result.kind === 'error') {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    if (result.kind === 'conflict') {
      // 409 + 服务端现状：客户端拉到对方笔迹后重放自己的操作
      res.status(409).json({
        success: false,
        error: '视野已被其他人更新，请合并后重试',
        conflict: {
          serverVersion: result.serverVersion,
          liveOps: result.liveOps,
          missingOps: result.missingOps ?? [],
        },
      });
      return;
    }
    res.json({ success: true, data: result.card, meta: { version: result.version, accepted: result.accepted } });
  });

  // 撤回自己的某条标注
  router.post('/cards/:id/withdraw-op', (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const opId = String(req.body?.opId ?? '');
    if (!opId) {
      res.status(400).json({ success: false, error: '缺少 opId' });
      return;
    }
    const result = store.withdrawOp(req.params.id, opId, identity.userId);
    if ('error' in result) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result });
  });

  // 撤回整张卡片
  router.delete('/cards/:id', (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const result = store.withdrawCard(req.params.id, identity.userId);
    if (result.error) {
      res.status(result.status ?? 400).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: { status: 'withdrawn' } });
  });

  // 点赞 / 取消（服务端以 userId 去重）
  router.post('/cards/:id/like', (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const liked = req.body?.liked !== false;
    const result = store.setLike(req.params.id, identity.userId, liked);
    if ('error' in result) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: { likeCount: result.likeCount, likedByMe: result.likedByMe } });
  });

  // 复刻到自己的标本页继续画
  router.post('/cards/:id/fork', (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const result = store.fork(req.params.id, identity.userId, identity.userName, process.env.AUTO_APPROVE === '1');
    if (result.error) {
      res.status(result.status ?? 400).json({ success: false, error: result.error });
      return;
    }
    res.status(201).json({ success: true, data: result.card });
  });

  // 审核队列 / 审核决定
  router.get('/moderation/queue', (req, res) => {
    if (!isModerator(req)) {
      res.status(403).json({ success: false, error: '需要审核员密钥' });
      return;
    }
    const { limit, offset } = parseListParams(req);
    const feed = store.listFeed({ status: 'pending', viewerId: null, limit, offset });
    res.json({ success: true, data: feed });
  });

  router.post('/moderation/cards/:id', (req, res) => {
    if (!isModerator(req)) {
      res.status(403).json({ success: false, error: '需要审核员密钥' });
      return;
    }
    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      res.status(400).json({ success: false, error: 'decision 必须是 approved / rejected' });
      return;
    }
    const result = store.moderate(req.params.id, decision, String(req.body?.reviewNote ?? ''));
    if ('error' in result) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result });
  });

  return router;
}

export { LIMITS };
