import { promisify } from 'node:util';
import { gunzip as gunzipCb } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';
import {
  AnnotationCard,
  CardEvent,
  CardStatus,
  CardSummary,
  CommitResult,
  LIMITS,
  ValidationError,
  genId,
  mergeCommit,
  normalizeOps,
  validateNote,
  validateTitle,
  visibleRecords,
  eventsSince,
} from '../../../shared/annotations.js';
import { db, listCards, countLikes, scheduleSave } from '../services/annotationStore.js';

const MOD_TOKEN = process.env.MOD_TOKEN || 'moderator';

/* ------------------------------ HTTP 基础设施 ------------------------------ */

const gunzip = promisify(gunzipCb);

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
const wrap =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

/**
 * 请求体解析：
 * - Content-Encoding: gzip → 用内置 zlib 解压；
 * - 原始体 ≤ 512KB，解压后 ≤ 1MB（压缩炸弹防护）；
 * - 超大笔迹数据在客户端还会先做量化/抽点压缩（见 src/utils/annotations/）。
 */
export async function readAnnotationBody(req: Request): Promise<unknown> {
  const chunks: Buffer[] = [];
  let raw = 0;
  for await (const c of req) {
    raw += c.length;
    if (raw > LIMITS.MAX_RAW_BODY_BYTES) {
      throw new ValidationError('BODY_TOO_LARGE', `请求体超过 ${LIMITS.MAX_RAW_BODY_BYTES} 字节（压缩前）`);
    }
    chunks.push(c as Buffer);
  }
  let buf = Buffer.concat(chunks);
  if (req.header('content-encoding')?.toLowerCase().includes('gzip')) {
    try {
      buf = await gunzip(buf);
    } catch {
      throw new ValidationError('GZIP_BAD', 'gzip 数据损坏');
    }
    if (buf.length > LIMITS.MAX_JSON_BYTES) {
      throw new ValidationError('DECOMPRESSED_TOO_LARGE', `解压后超过 ${LIMITS.MAX_JSON_BYTES} 字节`);
    }
  }
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new ValidationError('JSON_BAD', 'JSON 解析失败');
  }
}

interface Identity {
  id: string;
  name: string;
}

function identity(req: Request): Identity {
  const id = String(req.header('x-user-id') || '').trim();
  let name = String(req.header('x-user-name') || '').trim();
  try { name = decodeURIComponent(name); } catch { /* 非编码值原样使用 */ }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
    throw new ValidationError('USER_ID_BAD', '缺少合法的 X-User-Id（4~64 位字母数字_-）');
  }
  // eslint-disable-next-line no-control-regex -- 用户名剔除控制字符
  const safeName = (name || '访客').replace(/[\x00-\x1f<>&]/g, '').slice(0, 24) || '访客';
  return { id, name: safeName };
}

function requireMod(req: Request): void {
  if (req.header('x-mod-token') !== MOD_TOKEN) {
    const err = new ValidationError('FORBIDDEN', '需要审核员令牌 (X-Mod-Token)');
    err.status = 403;
    throw err;
  }
}

/** 极简内存限流：按 userId / IP 限制写操作频率（恶意内容刷屏防护之一） */
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(req: Request, key: string): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  b.count++;
  if (b.count > 120) {
    const err = new ValidationError('RATE_LIMITED', '写操作过于频繁（每分钟 120 次），请稍后再试');
    err.status = 429;
    throw err;
  }
}
// 周期清理，避免 map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 5 * 60_000).unref?.();

/* --------------------------------- 视图 --------------------------------- */

function toSummary(card: AnnotationCard, userId?: string): CardSummary {
  const visible = visibleRecords(card.events).length;
  return {
    id: card.id,
    specimenId: card.specimenId,
    title: card.title,
    note: card.note,
    authorId: card.authorId,
    authorName: card.authorName,
    status: card.status,
    version: card.version,
    opCount: visible,
    likeCount: countLikes(card.id),
    liked: userId ? db.likesFor(card.id).has(userId) : false,
    forkedFrom: card.forkedFrom,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function publicEvents(card: AnnotationCard, user: Identity | null, since: number | null): CardEvent[] {
  const isCardAuthor = user?.id === card.authorId;
  // 预计算每个 op 的作者，retract/hide 事件也要按归属过滤
  const authorOf = new Map<string, string>();
  for (const e0 of card.events) {
    if (e0.kind === 'add') authorOf.set(e0.record.id, e0.record.authorId);
  }
  let events = since === null ? card.events : eventsSince(card, since);
  // 可见性：
  // - 普通 add 事件人人可见（卡片 approved 或本人卡片才会走到这里）；
  // - 被撤回的笔迹（及对应 retract-op 事件）：卡片作者 或 该笔迹作者本人 可见；其他人拿不到；
  // - 被审核隐藏的笔迹：仅卡片作者可见；其他人拿不到。
  events = events.filter((e) => {
    if (e.kind === 'add') {
      const r = e.record;
      if (r.retracted) return isCardAuthor || r.authorId === user?.id;
      if (r.hidden) return isCardAuthor;
      return true;
    }
    if (e.kind === 'retract-op') return isCardAuthor || authorOf.get(e.opId) === user?.id;
    if (e.kind === 'hide-op') return isCardAuthor;
    return true;
  });
  return events;
}

function assertWritable(card: AnnotationCard): void {
  if (card.status === 'retracted') {
    throw new ValidationError('CARD_RETRACTED', '卡片已被作者撤回，不能再追加批注');
  }
}

/* --------------------------------- 路由 --------------------------------- */

export const AnnotationController = {
  /** GET /api/cards?specimenId=&mine=1&since=&status=  走廊 / 我的草稿 */
  list: wrap(async (req, res) => {
    const user = req.header('x-user-id')
      ? identity(req)
      : ({ id: '', name: '' } as Identity);
    const specimenId = req.query.specimenId ? Number(req.query.specimenId) : undefined;
    const mine = req.query.mine === '1';
    let cards = listCards({ specimenId, authorId: mine ? user.id || '__none__' : undefined });
    if (!mine) {
      // 公共走廊只挂通过审核的；非作者看不到 pending/draft/rejected/retracted
      cards = cards.filter((c) => c.status === 'approved');
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const summaries = cards.slice(0, limit).map((c) => toSummary(c, user.id || undefined));
    res.json({ success: true, data: summaries });
  }),

  /** POST /api/cards  建卡片（草稿），可同时带第一批笔迹 */
  create: wrap(async (req, res) => {
    const user = identity(req);
    rateLimit(req, user.id);
    const body = (await readAnnotationBody(req)) as {
      specimenId?: unknown;
      title?: unknown;
      note?: unknown;
      ops?: unknown;
    };
    const specimenId = Number(body.specimenId);
    if (!Number.isInteger(specimenId) || specimenId <= 0) {
      throw new ValidationError('SPECIMEN_BAD', 'specimenId 非法');
    }
    const title = validateTitle(body.title);
    const note = validateNote(body.note);
    const ops = body.ops ? normalizeOps(body.ops) : [];

    const now = Date.now();
    const card: AnnotationCard = {
      id: genId(),
      specimenId,
      title,
      note,
      authorId: user.id,
      authorName: user.name,
      status: 'draft',
      version: 0,
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    const merge = mergeCommit(card, 0, ops, user, now);
    db.cards[card.id] = card;
    scheduleSave();

    const result: CommitResult = { cardId: card.id, ...merge };
    res.status(201).json({ success: true, data: { card: toSummary(card, user.id), commit: result } });
  }),

  /** GET /api/cards/:id?since=N  取卡片（含从 N 起的增量事件） */
  get: wrap(async (req, res) => {
    const user = req.header('x-user-id') ? identity(req) : null;
    const card = db.cards[req.params.id];
    if (!card) throw new ValidationError('NOT_FOUND', '卡片不存在');
    if (card.status === 'retracted') {
      const err = new ValidationError('CARD_RETRACTED', '该卡片已撤回');
      err.status = 410;
      throw err;
    }
    if (card.status !== 'approved' && user?.id !== card.authorId) {
      const err = new ValidationError('NOT_VISIBLE', '该卡片尚未通过审核');
      err.status = 403;
      throw err;
    }
    const since = req.query.since !== undefined ? Number(req.query.since) : null;
    if (since !== null && (!Number.isInteger(since) || since < 0)) {
      throw new ValidationError('SINCE_BAD', 'since 必须是非负整数');
    }
    res.json({
      success: true,
      data: {
        card: toSummary(card, user?.id),
        status: card.status,
        note: card.note,
        events: publicEvents(card, user, since),
        forkedFrom: card.forkedFrom,
      },
    });
  }),

  /** POST /api/cards/:id/commits  追加笔迹（核心合并端点） */
  commit: wrap(async (req, res) => {
    const user = identity(req);
    rateLimit(req, user.id);
    const card = db.cards[req.params.id];
    if (!card) throw new ValidationError('NOT_FOUND', '卡片不存在');
    assertWritable(card);

    const body = (await readAnnotationBody(req)) as CommitBody;
    const baseVersion = Number(body.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      throw new ValidationError('BASE_BAD', 'baseVersion 必须是非负整数');
    }
    if (baseVersion > card.version) {
      throw new ValidationError('VERSION_AHEAD', '客户端版本比服务端还新，无法合并');
    }
    const ops = normalizeOps(body.ops);

    // 追加式合并：无论 baseVersion 新旧，新笔迹都 fast-forward 到日志尾部。
    // 已存在 opId 幂等跳过；返回 baseVersion 之后的全部事件——
    // 并发另一方的笔迹就在里面，客户端把它画到同一块画布上，绝不互相覆盖。
    const merge = mergeCommit(card, baseVersion, ops, user);
    scheduleSave();
    const result: CommitResult = { cardId: card.id, ...merge };
    res.json({ success: true, data: result });
  }),

  /** POST /api/cards/:id/publish | /retract  作者发布 / 撤回整张卡片 */
  lifecycle: wrap(async (req, res) => {
    const user = identity(req);
    const card = db.cards[req.params.id];
    if (!card) throw new ValidationError('NOT_FOUND', '卡片不存在');
    if (card.authorId !== user.id) {
      const err = new ValidationError('FORBIDDEN', '只能操作自己发布的标注');
      err.status = 403;
      throw err;
    }
    const action = req.params.action;
    const now = Date.now();

    if (action === 'publish') {
      if (card.status === 'approved') throw new ValidationError('ALREADY_APPROVED', '卡片已通过审核');
      if (visibleRecords(card.events).length === 0) {
        throw new ValidationError('EMPTY_CARD', '空卡片不能发布，请先在标本图上圈注');
      }
      const v = ++card.version;
      const status: CardStatus = 'pending';
      card.events.push({ v, kind: 'status', status, by: user.id });
      card.status = status;
      card.updatedAt = now;
    } else if (action === 'retract') {
      const v = ++card.version;
      card.events.push({ v, kind: 'status', status: 'retracted', by: user.id });
      card.status = 'retracted';
      card.updatedAt = now;
    } else {
      throw new ValidationError('ACTION_BAD', '未知生命周期动作');
    }
    scheduleSave();
    res.json({ success: true, data: { id: card.id, status: card.status, version: card.version } });
  }),

  /** POST /api/cards/:id/ops/:opId/retract  作者撤回自己已发布的某条笔迹 */
  retractOp: wrap(async (req, res) => {
    const user = identity(req);
    const card = db.cards[req.params.id];
    if (!card) throw new ValidationError('NOT_FOUND', '卡片不存在');
    const rec = card.events.find(
      (e) => e.kind === 'add' && e.record.id === req.params.opId,
    );
    if (!rec || rec.kind !== 'add') throw new ValidationError('OP_NOT_FOUND', '批注不存在');
    if (rec.record.authorId !== user.id && card.authorId !== user.id) {
      const err = new ValidationError('FORBIDDEN', '只能撤回自己的批注');
      err.status = 403;
      throw err;
    }
    if (rec.record.retracted || rec.record.hidden) {
      throw new ValidationError('ALREADY_RETRACTED', '该批注已撤回');
    }
    const now = Date.now();
    const v = ++card.version;
    card.events.push({ v, kind: 'retract-op', opId: req.params.opId, by: user.id });
    rec.record.retracted = true;
    card.updatedAt = now;
    scheduleSave();
    res.json({ success: true, data: { version: v } });
  }),

  /** POST /api/cards/:id/fork  把别人的标注复刻到自己的新草稿继续画 */
  fork: wrap(async (req, res) => {
    const user = identity(req);
    rateLimit(req, user.id);
    const src = db.cards[req.params.id];
    if (!src) throw new ValidationError('NOT_FOUND', '源卡片不存在');
    if (src.status !== 'approved') {
      const err = new ValidationError('NOT_FORKABLE', '只有已通过审核的公开卡片可以复刻');
      err.status = 403;
      throw err;
    }
    const now = Date.now();
    const card: AnnotationCard = {
      id: genId(),
      specimenId: src.specimenId,
      title: `${src.title}（复刻）`,
      note: src.note,
      authorId: user.id,
      authorName: user.name,
      status: 'draft',
      version: 0,
      forkedFrom: src.id,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    // 复刻当前可见笔迹，重新挂在新卡片事件流上（原笔迹作者保留在 record 里）
    const seed = visibleRecords(src.events).map((r) => r.op);
    mergeCommit(
      card,
      0,
      seed,
      { id: user.id, name: user.name },
      now,
    );
    // 修正复刻笔迹的作者署名（记录原作者）
    const srcById = new Map(visibleRecords(src.events).map((r) => [r.id, r]));
    for (const e of card.events) {
      if (e.kind === 'add') {
        const orig = srcById.get(e.record.id);
        if (orig) {
          e.record.authorId = orig.authorId;
          e.record.authorName = orig.authorName;
        }
      }
    }
    db.cards[card.id] = card;
    scheduleSave();
    res
      .status(201)
      .json({ success: true, data: { id: card.id, version: card.version, forkedFrom: src.id } });
  }),

  /** POST /api/cards/:id/like  点赞（服务端 Set 去重，重复点赞幂等，再点取消） */
  like: wrap(async (req, res) => {
    const user = identity(req);
    const card = db.cards[req.params.id];
    if (!card || card.status !== 'approved') {
      throw new ValidationError('LIKE_TARGET_BAD', '只能给已通过审核的公开卡片点赞');
    }
    const users = db.likesFor(card.id);
    const liked = users.has(user.id);
    if (liked) users.delete(user.id);
    else users.add(user.id);
    db.setLikes(card.id, users);
    res.json({ success: true, data: { likeCount: users.size, liked: !liked } });
  }),

  /* -------------------------------- 审核侧 -------------------------------- */

  /** GET /api/moderation/queue */
  modQueue: wrap(async (req, res) => {
    requireMod(req);
    const cards = listCards({ status: 'pending' });
    res.json({ success: true, data: cards.map((c) => toSummary(c)) });
  }),

  /** POST /api/moderation/cards/:id  {decision:'approved'|'rejected', reason} */
  modDecide: wrap(async (req, res) => {
    requireMod(req);
    const card = db.cards[req.params.id];
    if (!card) throw new ValidationError('NOT_FOUND', '卡片不存在');
    if (card.status !== 'pending') throw new ValidationError('NOT_PENDING', '该卡片不在待审队列');
    const body = (await readAnnotationBody(req)) as { decision?: unknown; reason?: unknown };
    const decision = String(body.decision ?? '');
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new ValidationError('DECISION_BAD', 'decision 必须是 approved / rejected');
    }
    const now = Date.now();
    const v = ++card.version;
    const reason =
      body.reason === undefined ? undefined : String(body.reason).replace(/[<>]/g, '').slice(0, 120);
    card.events.push({ v, kind: 'status', status: decision, by: 'moderator', reason });
    card.status = decision;
    card.updatedAt = now;
    scheduleSave();
    res.json({ success: true, data: { id: card.id, status: card.status, version: v } });
  }),

  /** POST /api/moderation/cards/:id/ops/:opId/hide  隐藏单条违规批注 */
  modHideOp: wrap(async (req, res) => {
    requireMod(req);
    const card = db.cards[req.params.id];
    if (!card) throw new ValidationError('NOT_FOUND', '卡片不存在');
    const rec = card.events.find((e) => e.kind === 'add' && e.record.id === req.params.opId);
    if (!rec || rec.kind !== 'add') throw new ValidationError('OP_NOT_FOUND', '批注不存在');
    if (rec.record.hidden) throw new ValidationError('ALREADY_HIDDEN', '该批注已隐藏');
    const v = ++card.version;
    card.events.push({ v, kind: 'hide-op', opId: req.params.opId, by: 'moderator' });
    rec.record.hidden = true;
    card.updatedAt = Date.now();
    scheduleSave();
    res.json({ success: true, data: { version: v } });
  }),
};

type CommitBody = { baseVersion?: unknown; ops?: unknown };

export { toSummary };
