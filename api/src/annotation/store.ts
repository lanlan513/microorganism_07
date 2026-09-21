/**
 * 涂鸦共享馆服务端存储层
 *
 * 存储介质：单个 JSON 文件（原子写：写临时文件再 rename）。
 * 选它是因为演示环境无需外部数据库；所有访问都是同步函数，
 * Node 单线程事件循环天然把每个 HTTP handler 串行化，
 * 因此"并发 append"的裁决只取决于我们自己的版本号检查，
 * 这恰好能稳定复现 409 冲突流程（见 scripts/conflict-demo.mjs）。
 *
 * 生产环境应替换为 SQLite/Postgres：cards / card_log / likes 三张表，
 * log 表上 (card_id, version) 唯一索引即等价于下面的 appendAt。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LIMITS,
  byteLength,
  isTombstone,
  reduceLog,
  sanitizeNote,
  sanitizeStroke,
  uuid,
  type AnyLogEntry,
  type AppendOp,
  type CardStatus,
  type LogEntry,
  type MarkPayload,
} from '../../../shared/annotation.js';

export interface DBCard {
  id: string;
  specimenId: number;
  title: string;
  authorId: string;
  authorName: string;
  status: CardStatus;
  createdAt: number;
  updatedAt: number;
  forkedFrom: string | null;
  reviewNote: string;
  /** 追加式日志：append 的笔迹 + 撤回墓碑，永不原地修改 */
  log: AnyLogEntry[];
  /** 点赞用户 ID —— 服务端去重就靠这个集合 */
  likes: string[];
}

interface DB {
  cards: Record<string, DBCard>;
  /** 被删除/驳回过的恶意文本留痕（审计） */
  moderationLog: { cardId: string; at: number; action: string; note: string }[];
}

export interface CardSummary {
  id: string;
  specimenId: number;
  title: string;
  authorId: string;
  authorName: string;
  status: CardStatus;
  createdAt: number;
  updatedAt: number;
  forkedFrom: string | null;
  version: number;
  strokeCount: number;
  noteCount: number;
  likeCount: number;
  likedByMe: boolean;
}

export interface CardDetail extends CardSummary {
  reviewNote: string;
  liveOps: LogEntry[];
}

export type AppendResult =
  | { kind: 'ok'; version: number; accepted: LogEntry[]; card: CardDetail }
  | { kind: 'conflict'; serverVersion: number; liveOps: LogEntry[]; missingOps?: string[] }
  | { kind: 'error'; status: number; error: string };

const FORBIDDEN_PATTERNS = [
  /<\s*script/i,
  /javascript\s*:/i,
  /on(error|load|click)\s*=/i,
  /<\s*iframe/i,
  /<\s*img[^>]+src\s*=/i,
];

export function scanMalicious(text: string): string | null {
  for (const re of FORBIDDEN_PATTERNS) {
    const m = text.match(re);
    if (m) return `文本含不被允许的内容：${m[0].slice(0, 24)}`;
  }
  return null;
}

export class AnnotationStore {
  private db: DB;
  private path: string;

  constructor(path: string) {
    this.path = path;
    this.db = { cards: {}, moderationLog: [] };
    if (existsSync(path)) {
      try {
        this.db = JSON.parse(readFileSync(path, 'utf8')) as DB;
      } catch {
        // 损坏的库文件：备份后重建，避免一个坏文件让服务起不来
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      }
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.path);
  }

  private toDetail(card: DBCard, viewerId: string | null): CardDetail {
    const liveOps = reduceLog(card.log);
    return {
      id: card.id,
      specimenId: card.specimenId,
      title: card.title,
      authorId: card.authorId,
      authorName: card.authorName,
      status: card.status,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      forkedFrom: card.forkedFrom,
      reviewNote: card.reviewNote,
      version: card.log.length,
      strokeCount: liveOps.filter((o) => o.payload.kind === 'stroke').length,
      noteCount: liveOps.filter((o) => o.payload.kind === 'note').length,
      likeCount: card.likes.length,
      likedByMe: viewerId ? card.likes.includes(viewerId) : false,
      liveOps,
    };
  }

  private toSummary(card: DBCard, viewerId: string | null): CardSummary {
    const d = this.toDetail(card, viewerId);
    const { liveOps: _liveOps, reviewNote: _reviewNote, ...summary } = d;
    return summary;
  }

  // ---------- 校验一条操作（体积上限 / 坐标 / 文本 / 恶意内容） ----------
  private validateOp(raw: unknown, userId: string): { op?: AppendOp; error?: string } {
    if (!raw || typeof raw !== 'object') return { error: '操作格式错误' };
    const r = raw as Partial<AppendOp>;
    if (typeof r.opId !== 'string' || !/^[a-zA-Z0-9_-]{6,64}$/.test(r.opId)) {
      return { error: 'opId 非法（需 6-64 位字母数字 _-）' };
    }
    if (!r.payload || typeof r.payload !== 'object') return { error: '缺少标注内容' };
    if (byteLength(JSON.stringify(r.payload)) > LIMITS.MAX_STROKE_BYTES) {
      return { error: `单条标注体积超过 ${LIMITS.MAX_STROKE_BYTES} 字节上限` };
    }
    const kind = (r.payload as MarkPayload).kind;
    let payload: MarkPayload;
    if (kind === 'stroke') {
      const s = sanitizeStroke((r.payload as { stroke: unknown }).stroke);
      if ('error' in s) return { error: s.error };
      payload = { kind: 'stroke', stroke: s };
    } else if (kind === 'note') {
      const n = sanitizeNote((r.payload as { note: unknown }).note);
      if ('error' in n) return { error: n.error };
      const evil = scanMalicious(n.text);
      if (evil) return { error: evil };
      payload = { kind: 'note', note: n };
    } else {
      return { error: `未知标注类型: ${String(kind)}` };
    }
    const op: AppendOp = {
      opId: r.opId,
      authorId: userId, // 作者身份以服务端认证为准，忽略客户端自报
      authorName: typeof r.authorName === 'string' ? r.authorName.slice(0, 32) : '匿名研究员',
      createdAt: Number.isFinite(r.createdAt) ? (r.createdAt as number) : Date.now(),
      payload,
    };
    return { op };
  }

  createCard(input: {
    specimenId: number;
    title: string;
    userId: string;
    userName: string;
    ops: unknown[];
    forkedFrom?: string | null;
    autoApprove: boolean;
  }): { card?: CardDetail; error?: string; status?: number } {
    const specimenId = Math.floor(Number(input.specimenId));
    if (!Number.isInteger(specimenId) || specimenId <= 0) {
      return { status: 400, error: 'specimenId 非法' };
    }
    const title = (input.title ?? '').toString();
    const evil = scanMalicious(title);
    if (evil) return { status: 400, error: evil };
    if (!Array.isArray(input.ops) || input.ops.length === 0) {
      return { status: 400, error: '讲解卡片至少包含一条笔迹或批注' };
    }
    if (input.ops.length > LIMITS.MAX_OPS_PER_APPEND) {
      return { status: 400, error: `单次最多 ${LIMITS.MAX_OPS_PER_APPEND} 条标注` };
    }
    const ops: AppendOp[] = [];
    const seenIds = new Set<string>();
    for (const raw of input.ops) {
      const { op, error } = this.validateOp(raw, input.userId);
      if (error) return { status: 400, error };
      if (seenIds.has(op!.opId)) return { status: 400, error: '请求内 opId 重复' };
      seenIds.add(op!.opId);
      ops.push(op!);
    }
    let forkedFrom: string | null = null;
    if (input.forkedFrom) {
      const src = this.db.cards[input.forkedFrom];
      if (!src) return { status: 404, error: '被复刻的卡片不存在' };
      if (src.status !== 'approved') return { status: 403, error: '只能复刻已通过审核的公开卡片' };
      forkedFrom = src.id;
    }
    const now = Date.now();
    const card: DBCard = {
      id: uuid(),
      specimenId,
      title: title.slice(0, LIMITS.MAX_TITLE_CHARS) || '未命名讲解',
      authorId: input.userId,
      authorName: input.userName,
      status: input.autoApprove ? 'approved' : 'pending',
      createdAt: now,
      updatedAt: now,
      forkedFrom,
      reviewNote: '',
      log: [],
      likes: [],
    };
    this.db.cards[card.id] = card;
    const result = this.appendOps(card.id, 0, ops, input.userId, { skipStatusCheck: true });
    if (result.kind !== 'ok') {
      delete this.db.cards[card.id];
      return { status: 400, error: result.kind === 'error' ? result.error : '创建失败' };
    }
    this.persist();
    return { card: this.getCard(card.id, input.userId) ?? undefined };
  }

  getCard(id: string, viewerId: string | null): CardDetail | null {
    const card = this.db.cards[id];
    return card ? this.toDetail(card, viewerId) : null;
  }

  /** 增量拉取：只返回 sinceVersion 之后的日志条目（含墓碑），防止长日志反复全量传输 */
  getDelta(id: string, sinceVersion: number) {
    const card = this.db.cards[id];
    if (!card) return null;
    const entries = card.log.filter((e) => e.version > sinceVersion);
    return { version: card.log.length, status: card.status, entries };
  }

  listFeed(query: {
    specimenId?: number;
    status?: CardStatus;
    viewerId: string | null;
    limit: number;
    offset: number;
  }): { total: number; items: CardSummary[] } {
    let cards = Object.values(this.db.cards);
    if (query.specimenId) cards = cards.filter((c) => c.specimenId === query.specimenId);
    if (query.status) cards = cards.filter((c) => c.status === query.status);
    else cards = cards.filter((c) => c.status !== 'withdrawn');
    cards.sort((a, b) => b.updatedAt - a.updatedAt);
    const total = cards.length;
    const items = cards
      .slice(query.offset, query.offset + query.limit)
      .map((c) => this.toSummary(c, query.viewerId));
    return { total, items };
  }

  listByAuthor(userId: string, limit: number, offset: number): { total: number; items: CardSummary[] } {
    const cards = Object.values(this.db.cards)
      .filter((c) => c.authorId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      total: cards.length,
      items: cards.slice(offset, offset + limit).map((c) => this.toSummary(c, userId)),
    };
  }

  /**
   * 1) 幂等：已存在的 opId 当作成功返回（断网重试不会重复画）；
   * 2) 版本检查：baseVersion 必须等于当前日志长度，否则 409 + 返回服务端现状；
   * 3) 追加：每条新操作获得 version = ++length。两个并发请求只有一个能通过版本检查。
   */
  appendOps(
    cardId: string,
    baseVersion: number,
    rawOps: unknown[],
    userId: string,
    opts: { skipStatusCheck?: boolean } = {},
  ): AppendResult {
    const card = this.db.cards[cardId];
    if (!card) return { kind: 'error', status: 404, error: '卡片不存在' };
    if (!opts.skipStatusCheck && (card.status === 'withdrawn' || card.status === 'rejected')) {
      return { kind: 'error', status: 403, error: '该卡片已撤回/驳回，不能继续批注' };
    }
    // 审核中的卡片只有作者本人能继续画；通过后任何人都可在同一视野追加
    if (!opts.skipStatusCheck && card.status === 'pending' && card.authorId !== userId) {
      return { kind: 'error', status: 403, error: '卡片审核中，通过后才能追加批注' };
    }
    if (!Array.isArray(rawOps) || rawOps.length === 0) {
      return { kind: 'error', status: 400, error: '缺少要追加的标注' };
    }
    if (rawOps.length > LIMITS.MAX_OPS_PER_APPEND) {
      return { kind: 'error', status: 400, error: `单次最多 ${LIMITS.MAX_OPS_PER_APPEND} 条标注` };
    }

    const validated: AppendOp[] = [];
    const requestIds = new Set<string>();
    for (const raw of rawOps) {
      const { op, error } = this.validateOp(raw, userId);
      if (error) return { kind: 'error', status: 400, error };
      if (requestIds.has(op!.opId)) {
        return { kind: 'error', status: 400, error: '请求内 opId 重复' };
      }
      requestIds.add(op!.opId);
      validated.push(op!);
    }

    // 1) 幂等过滤（重试的旧操作直接视为已接受）
    const existing = new Set(card.log.map((e) => e.opId));
    const fresh = validated.filter((o) => !existing.has(o.opId));
    const replayed = validated.filter((o) => existing.has(o.opId));
    const missingOps = replayed.map((o) => o.opId);

    // 2) 版本裁决：有新操作要写入时才检查版本；纯重放即使版本落后也返回成功
    if (fresh.length > 0 && baseVersion !== card.log.length) {
      return {
        kind: 'conflict',
        serverVersion: card.log.length,
        liveOps: reduceLog(card.log),
        ...(missingOps.length ? { missingOps } : {}),
      };
    }

    // 3) 追加
    const accepted: LogEntry[] = [];
    for (const op of fresh) {
      const entry: LogEntry = { ...op, version: card.log.length + 1 };
      card.log.push(entry);
      accepted.push(entry);
    }
    card.updatedAt = Date.now();
    this.persist();
    return { kind: 'ok', version: card.log.length, accepted, card: this.toDetail(card, userId) };
  }

  /** 撤回自己发布的某条标注（追加墓碑，不删数据） */
  withdrawOp(cardId: string, opId: string, userId: string): CardDetail | { error: string; status: number } {
    const card = this.db.cards[cardId];
    if (!card) return { status: 404, error: '卡片不存在' };
    const target = card.log.find((e) => !isTombstone(e) && e.opId === opId);
    if (!target) return { status: 404, error: '标注不存在' };
    // 只能撤回自己画的标注（卡主也不能撤别人追加的批注）
    if (target.authorId !== userId) {
      return { status: 403, error: '只能撤回自己的标注' };
    }
    if (card.log.some((e) => isTombstone(e) && e.targetOpId === opId)) {
      return { status: 409, error: '该标注已被撤回' }; // 幂等保护
    }
    card.log.push({
      version: card.log.length + 1,
      opId: uuid(),
      type: 'tombstone',
      authorId: userId,
      createdAt: Date.now(),
      targetOpId: opId,
    });
    card.updatedAt = Date.now();
    this.persist();
    return this.toDetail(card, userId);
  }

  /** 整张卡片撤回（作者本人） */
  withdrawCard(cardId: string, userId: string): { error?: string; status?: number } {
    const card = this.db.cards[cardId];
    if (!card) return { status: 404, error: '卡片不存在' };
    if (card.authorId !== userId) return { status: 403, error: '只能撤回自己的卡片' };
    card.status = 'withdrawn';
    card.updatedAt = Date.now();
    this.persist();
    return {};
  }

  setLike(cardId: string, userId: string, liked: boolean): CardDetail | { error: string; status: number } {
    const card = this.db.cards[cardId];
    if (!card) return { status: 404, error: '卡片不存在' };
    if (card.status !== 'approved') return { status: 403, error: '只能点赞已通过审核的公开卡片' };
    const i = card.likes.indexOf(userId);
    if (liked && i === -1) card.likes.push(userId);
    if (!liked && i !== -1) card.likes.splice(i, 1);
    card.updatedAt = Date.now();
    this.persist();
    return this.toDetail(card, userId);
  }

  moderate(
    cardId: string,
    decision: 'approved' | 'rejected',
    reviewNote: string,
  ): CardDetail | { error: string; status: number } {
    const card = this.db.cards[cardId];
    if (!card) return { status: 404, error: '卡片不存在' };
    card.status = decision;
    card.reviewNote = reviewNote.slice(0, 200);
    card.updatedAt = Date.now();
    this.db.moderationLog.push({ cardId, at: Date.now(), action: decision, note: card.reviewNote });
    this.persist();
    return this.toDetail(card, null);
  }

  /** 复刻：把别人卡片上的存活笔迹复制成自己标本页上的新卡片草稿，之后可继续画 */
  fork(
    sourceId: string,
    userId: string,
    userName: string,
    autoApprove: boolean,
  ): { card?: CardDetail; error?: string; status?: number } {
    const src = this.db.cards[sourceId];
    if (!src) return { status: 404, error: '卡片不存在' };
    if (src.status !== 'approved') return { status: 403, error: '只能复刻已通过审核的公开卡片' };
    const live = reduceLog(src.log);
    const now = Date.now();
    const card: DBCard = {
      id: uuid(),
      specimenId: src.specimenId,
      title: `${src.title} · 复刻`,
      authorId: userId,
      authorName: userName,
      status: autoApprove ? 'approved' : 'pending',
      createdAt: now,
      updatedAt: now,
      forkedFrom: src.id,
      reviewNote: '',
      log: [],
      likes: [],
    };
    this.db.cards[card.id] = card;
    // 复制的笔迹重新编号为新日志（保留原作者署名在 authorName 里体现出处）
    for (const op of live) {
      card.log.push({
        ...op,
        opId: uuid(),
        version: card.log.length + 1,
        // 复刻件里的笔迹归属：追加自己批注时仍可区分原作者
        authorName: `${op.authorName}〔原作〕`,
      });
    }
    this.persist();
    return { card: this.getCard(card.id, userId) ?? undefined };
  }
}
