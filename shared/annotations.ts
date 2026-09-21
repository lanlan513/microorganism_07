/**
 * 讲解卡片（矢量批注）共享类型与规则
 * 前后端共用：服务端用它做校验/合并，前端用它做采集/压缩/本地草稿。
 *
 * 核心模型：卡片 = 元信息 + 一条「只追加事件日志」(event log)。
 * - 每次成功写入都会让 version 单调 +1；
 * - 冲突不靠锁，靠「追加 + 版本号」：后写者把自己的笔迹 fast-forward 到日志尾部，
 *   谁先谁后由事件上的 version 决定，任何一方都不会覆盖另一方的笔迹。
 */

export type AnnotationType = 'stroke' | 'text';
export type CardStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'retracted';

export interface StrokePoint {
  /** 相对标本图宽的归一化坐标 0..1（图是正方形，y 同理） */
  x: number;
  y: number;
  /** 压感 0..1；触摸/鼠标给不了时给 0.5，由速度补偿笔锋 */
  p: number;
  /** 采点时间戳(ms)，用于速度驱动粗细 */
  t: number;
}

export interface StrokeOp {
  id: string;
  type: 'stroke';
  color: string;
  /** 基准笔宽 = 画布宽的比例，如 0.006 */
  width: number;
  points: StrokePoint[];
}

export interface TextOp {
  id: string;
  type: 'text';
  x: number;
  y: number;
  text: string;
  /** 字号 = 画布宽的比例，如 0.028 */
  size: number;
  color: string;
}

export type AnnotationOp = StrokeOp | TextOp;

/** 服务端事件日志里的一条「笔迹入库」记录 */
export interface OpRecord {
  v: number;
  id: string;
  op: AnnotationOp;
  authorId: string;
  authorName: string;
  ts: number;
  retracted?: boolean;
  hidden?: boolean;
}

export type CardEvent =
  | { v: number; kind: 'add'; record: OpRecord }
  | { v: number; kind: 'retract-op'; opId: string; by: string }
  | { v: number; kind: 'hide-op'; opId: string; by: string }
  | { v: number; kind: 'status'; status: CardStatus; by: string; reason?: string };

export interface AnnotationCard {
  id: string;
  specimenId: number;
  title: string;
  /** 两句讲解 */
  note: string;
  authorId: string;
  authorName: string;
  status: CardStatus;
  version: number;
  forkedFrom: string | null;
  createdAt: number;
  updatedAt: number;
  events: CardEvent[];
}

export interface CardSummary {
  id: string;
  specimenId: number;
  title: string;
  note: string;
  authorId: string;
  authorName: string;
  status: CardStatus;
  version: number;
  opCount: number;
  likeCount: number;
  liked?: boolean;
  forkedFrom: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CommitRequest {
  baseVersion: number;
  ops: AnnotationOp[];
}

export interface CommitResult {
  cardId: string;
  /** 提交后的最新版本号 */
  version: number;
  /** baseVersion 之后发生的全部事件（含对方刚写入的笔迹 + 自己这批） */
  events: CardEvent[];
  /** 本次被真正接收的 op id（重发的幂等 id 不会重复入库） */
  accepted: string[];
  /** 已存在因而被跳过的 op id */
  duplicates: string[];
}

/* ---------------- 体积 / 内容上限（边界规则单一事实来源） ---------------- */

export const LIMITS = {
  /** 单条文本最大字符数（超长文本 400） */
  MAX_TEXT_LEN: 300,
  /** 单条笔迹最大点数（防超大笔迹） */
  MAX_POINTS_PER_STROKE: 2000,
  /** 单次提交最多笔迹数 */
  MAX_STROKES_PER_COMMIT: 200,
  /** 单次提交最多文本数 */
  MAX_TEXTS_PER_COMMIT: 20,
  /** 一张卡片事件总数硬顶，超过后建议「复刻到新卡片继续画」 */
  MAX_EVENTS_PER_CARD: 8000,
  /** 解压前请求体上限 */
  MAX_RAW_BODY_BYTES: 512 * 1024,
  /** gzip 解压后请求体上限（压缩炸弹防护） */
  MAX_JSON_BYTES: 1024 * 1024,
  /** 标题长度 */
  MAX_TITLE_LEN: 60,
} as const;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const UUID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** 去掉控制字符与 HTML 尖括号（渲染端仍走 textContent / React 转义，双保险） */
export function sanitizeText(input: unknown, max: number): string {
  let s = String(input ?? '');
  // 去掉 C0/C1 控制字符（保留 \t\n）
  // eslint-disable-next-line no-control-regex -- 这里就是要剔除 C0/C1 控制字符
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  // 零宽/BiDi 控制字符清掉（防恶意伪装）
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '');
  // 尖括号转义，防注入片段（渲染端仍走 React 转义，双保险）
  s = s.replace(/</g, '＜').replace(/>/g, '＞');
  return s.slice(0, max);
}

export class ValidationError extends Error {
  status = 400;
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * 校验 + 规整一批 op。
 * 规整（量化坐标/压感小数位）同时是「体积压缩」：12 位浮点 → 3~4 位。
 */
export function normalizeOps(input: unknown): AnnotationOp[] {
  if (!Array.isArray(input)) throw new ValidationError('OPS_NOT_ARRAY', 'ops 必须是数组');
  if (input.length > LIMITS.MAX_STROKES_PER_COMMIT + LIMITS.MAX_TEXTS_PER_COMMIT) {
    throw new ValidationError('COMMIT_TOO_MANY_OPS', '单次提交的批注数量超限');
  }
  let strokes = 0;
  let texts = 0;
  const out: AnnotationOp[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new ValidationError('OP_BAD', '批注格式错误');
    const id = String((raw as { id?: unknown }).id ?? '');
    if (!UUID_RE.test(id)) throw new ValidationError('OP_ID_BAD', `批注 id 非法: ${id.slice(0, 32)}`);

    if (raw.type === 'stroke') {
      if (++strokes > LIMITS.MAX_STROKES_PER_COMMIT) {
        throw new ValidationError('TOO_MANY_STROKES', '单次提交笔迹数超限');
      }
      const s = raw as Partial<StrokeOp>;
      if (!Array.isArray(s.points) || s.points.length < 2) {
        throw new ValidationError('STROKE_TOO_SHORT', `笔迹 ${id} 至少需要 2 个点`);
      }
      if (s.points.length > LIMITS.MAX_POINTS_PER_STROKE) {
        throw new ValidationError('STROKE_TOO_LONG', `笔迹 ${id} 点数超过 ${LIMITS.MAX_POINTS_PER_STROKE}`);
      }
      const color = String(s.color ?? '');
      if (!COLOR_RE.test(color)) throw new ValidationError('COLOR_BAD', `笔迹 ${id} 颜色非法`);
      const width = Number(s.width);
      if (!(width > 0 && width <= 0.1)) throw new ValidationError('WIDTH_BAD', `笔迹 ${id} 笔宽非法`);

      let lastT = -1;
      const points: StrokePoint[] = s.points.map((pt, i) => {
        const x = Number(pt?.x);
        const y = Number(pt?.y);
        const p = Number(pt?.p);
        const t = Number(pt?.t) | 0;
        if (![x, y, p].every((n) => Number.isFinite(n))) {
          throw new ValidationError('POINT_BAD', `笔迹 ${id} 第 ${i} 点非法`);
        }
        if (x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) {
          throw new ValidationError('POINT_OUT_OF_RANGE', `笔迹 ${id} 第 ${i} 点超出画布`);
        }
        if (t < lastT) throw new ValidationError('TIME_NOT_MONOTONIC', `笔迹 ${id} 时间戳必须递增`);
        lastT = t;
        return { x: round4(x), y: round4(y), p: round3(Math.min(1, Math.max(0, p))), t };
      });

      out.push({ id, type: 'stroke', color, width: round4(width), points });
    } else if (raw.type === 'text') {
      if (++texts > LIMITS.MAX_TEXTS_PER_COMMIT) {
        throw new ValidationError('TOO_MANY_TEXTS', '单次提交文本数超限');
      }
      const tx = raw as Partial<TextOp>;
      const x = Number(tx.x);
      const y = Number(tx.y);
      const size = Number(tx.size);
      if (![x, y, size].every((n) => Number.isFinite(n))) {
        throw new ValidationError('TEXT_PLACE_BAD', `文本 ${id} 坐标非法`);
      }
      if (x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) {
        throw new ValidationError('TEXT_OUT_OF_RANGE', `文本 ${id} 超出画布`);
      }
      if (!(size > 0 && size <= 0.2)) throw new ValidationError('TEXT_SIZE_BAD', `文本 ${id} 字号非法`);
      const color = String(tx.color ?? '');
      if (!COLOR_RE.test(color)) throw new ValidationError('COLOR_BAD', `文本 ${id} 颜色非法`);
      const text = sanitizeText(tx.text, LIMITS.MAX_TEXT_LEN);
      if (!text.trim()) throw new ValidationError('TEXT_EMPTY', `文本 ${id} 内容为空`);
      out.push({ id, type: 'text', x: round4(x), y: round4(y), size: round4(size), color, text });
    } else {
      throw new ValidationError('OP_TYPE_BAD', '未知批注类型');
    }
  }
  return out;
}

export function validateNote(input: unknown): string {
  const s = sanitizeText(input, LIMITS.MAX_TEXT_LEN);
  if (!s.trim()) throw new ValidationError('NOTE_EMPTY', '讲解不能为空');
  return s;
}

export function validateTitle(input: unknown): string {
  const s = sanitizeText(input, LIMITS.MAX_TITLE_LEN).trim();
  if (!s) throw new ValidationError('TITLE_EMPTY', '标题不能为空');
  return s;
}

/* ---------------- 事件日志 → 可见笔迹 ---------------- */

export interface ApplyOptions {
  includeRetracted?: boolean;
  includeHidden?: boolean;
}

/** 把只追加事件日志折叠成当前可见的笔迹记录 */
export function visibleRecords(events: CardEvent[], opts: ApplyOptions = {}): OpRecord[] {
  const retracted = new Set<string>();
  const hidden = new Set<string>();
  const byId = new Map<string, OpRecord>();
  for (const e of events) {
    if (e.kind === 'add') byId.set(e.record.id, e.record);
    else if (e.kind === 'retract-op') retracted.add(e.opId);
    else if (e.kind === 'hide-op') hidden.add(e.opId);
    else if (e.kind === 'status') {
      if (e.status !== 'retracted') continue;
    }
  }
  const out: OpRecord[] = [];
  for (const e of events) {
    if (e.kind !== 'add') continue;
    const r = e.record;
    if (retracted.has(r.id)) {
      if (opts.includeRetracted) out.push({ ...r, retracted: true });
      continue;
    }
    if (hidden.has(r.id)) {
      if (opts.includeHidden) out.push({ ...r, hidden: true });
      continue;
    }
    out.push(r);
  }
  return out;
}

/** 从某个版本号之后的增量事件（增量同步：反复追加后加载不退化） */
export function eventsSince(card: AnnotationCard, since: number): CardEvent[] {
  if (!Number.isInteger(since) || since < 0) return card.events;
  // 事件按 v 递增存储，二分定位第一个 v > since
  let lo = 0;
  let hi = card.events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (card.events[mid].v <= since) lo = mid + 1;
    else hi = mid;
  }
  return card.events.slice(lo);
}

/**
 * 服务端合并内核（纯函数，测试可直接调用）：
 * 1. 已存在的 opId → 幂等跳过（重试安全）；
 * 2. 新 op 一律追加到日志尾部并分配 v，与 baseVersion 是否落后无关（fast-forward）；
 * 3. 返回「请求方 baseVersion 之后」的全部事件——并发落后方因此能在响应里直接看到
 *    对方刚写入的笔迹，而不是只看到自己这批；不删除、不改写任何已有事件。
 *
 * 注意 baseVersion 必须是「客户端提交时所基于的版本」，不能用 card.version：
 * 后者在追加后已经前移，会把落后方错过的对方笔迹裁掉。
 */
export function mergeCommit(
  card: AnnotationCard,
  baseVersion: number,
  ops: AnnotationOp[],
  _author: { id: string; name: string },
  now = Date.now(),
): Pick<CommitResult, 'events' | 'accepted' | 'duplicates' | 'version'> {
  const existing = new Set<string>();
  for (const e of card.events) if (e.kind === 'add') existing.add(e.record.id);

  const accepted: string[] = [];
  const duplicates: string[] = [];

  for (const op of ops) {
    if (existing.has(op.id)) {
      duplicates.push(op.id);
      continue;
    }
    if (card.events.length >= LIMITS.MAX_EVENTS_PER_CARD) {
      throw new ValidationError('CARD_FULL', `卡片已达 ${LIMITS.MAX_EVENTS_PER_CARD} 事件上限，请复刻为新卡片继续画`);
    }
    const v = ++card.version;
    const record: OpRecord = {
      v,
      id: op.id,
      op,
      authorId: _author.id,
      authorName: _author.name,
      ts: now,
    };
    card.events.push({ v, kind: 'add', record });
    existing.add(op.id);
    accepted.push(op.id);
  }
  if (accepted.length) card.updatedAt = now;

  return {
    version: card.version,
    // 用客户端基线裁剪：baseVersion 之后发生的一切（含并发对方的笔迹 + 自己这批）
    events: eventsSince(card, baseVersion),
    accepted,
    duplicates,
  };
}

export function genId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
