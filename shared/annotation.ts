/**
 * 涂鸦共享馆 —— 前后端共享的领域类型与纯函数
 *
 * 核心模型：讲解卡片(Card) = 一条标本视野(specimenId)上的操作日志(op log)。
 * 所有笔迹/文本都是操作，操作只能追加(append)或撤回(tombstone)，从不原地修改，
 * 因此"两个人同时画"在服务端天然不会互相覆盖：每个 append 获得单调递增的版本号。
 */

// ---------- 限制常量（超大笔迹体积 / 超长文本的边界） ----------
export const LIMITS = {
  /** 单条笔迹最多采样点（压缩前服务端也会强制裁断） */
  MAX_POINTS_PER_STROKE: 600,
  /** 单次 append 请求里最多携带的操作数 */
  MAX_OPS_PER_APPEND: 50,
  /** 单条笔迹 JSON 序列化后的字节上限（~24KB：600点 * 3数字 足够） */
  MAX_STROKE_BYTES: 32 * 1024,
  /** 整个创建卡片请求体上限 */
  MAX_CARD_BODY_BYTES: 96 * 1024,
  /** 讲解标题长度（码点） */
  MAX_TITLE_CHARS: 60,
  /** 文本批注长度（码点） */
  MAX_NOTE_CHARS: 500,
  /** 撤销/重做栈至少保留步数（前端实际保存 100 步） */
  UNDO_REDO_MIN: 20,
  UNDO_REDO_CAP: 100,
  /** 视野坐标系逻辑尺寸，笔迹坐标统一归一化到 0..FIELD_UNIT */
  FIELD_UNIT: 1000,
} as const;

export type CardStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** 矢量笔迹：字段坐标 0..1000 的点序列，w 为该点笔锋粗（字段单位） */
export interface Stroke {
  color: string;
  /** 每个点: [x, y, w]，w 可选（默认取相邻点） */
  points: [number, number, number][];
}

export interface Note {
  x: number;
  y: number;
  /** 两句讲解 */
  text: string;
}

export type MarkPayload =
  | { kind: 'stroke'; stroke: Stroke }
  | { kind: 'note'; note: Note };

/** 追加到卡片日志上的一条操作 */
export interface AppendOp {
  /** 客户端生成的幂等 ID，断网重试/重复提交时服务端去重 */
  opId: string;
  authorId: string;
  authorName: string;
  createdAt: number;
  payload: MarkPayload;
}

/** 服务端落盘的日志条目（带版本号，版本 = 该操作追加后的日志长度） */
export interface LogEntry extends AppendOp {
  version: number;
}

/** 撤回操作：把某条 op 标记为墓碑 */
export interface TombstoneEntry {
  version: number;
  opId: string;
  type: 'tombstone';
  authorId: string;
  createdAt: number;
  targetOpId: string;
}

export type AnyLogEntry = LogEntry | TombstoneEntry;

export interface Card {
  id: string;
  specimenId: number;
  title: string;
  authorId: string;
  authorName: string;
  status: CardStatus;
  createdAt: number;
  updatedAt: number;
  forkedFrom?: string | null;
  reviewNote?: string;
  /** 当前版本号 = 存活操作数 + 墓碑数（即日志长度） */
  version: number;
  /** 存活的标注操作（墓碑已过滤），按版本排序 */
  liveOps: LogEntry[];
  likeCount: number;
  likedByMe?: boolean;
}

/** 走廊列表摘要：刻意不带 liveOps，保证列表轻量、长日志不拖垮加载 */
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

/** 卡片详情：在摘要基础上带审核备注与完整存活笔迹 */
export interface CardDetail extends CardSummary {
  reviewNote: string;
  liveOps: LogEntry[];
}

// ---------- 纯函数：服务端归约 & 客户端合并共用 ----------

export function isTombstone(e: AnyLogEntry): e is TombstoneEntry {
  return (e as TombstoneEntry).type === 'tombstone';
}

/** 类型守卫：取笔迹类操作（给 UI 的 filter 用，保证 discriminated union 能收窄） */
export function isStrokeOp(
  op: LogEntry,
): op is LogEntry & { payload: { kind: 'stroke'; stroke: Stroke } } {
  return op.payload.kind === 'stroke';
}

export function isNoteOp(
  op: LogEntry,
): op is LogEntry & { payload: { kind: 'note'; note: Note } } {
  return op.payload.kind === 'note';
}

/**
 * 从完整日志归约出存活操作（追加式合并的核心：
 * 不删日志，只过滤墓碑；冲突时双方笔迹都在日志里，必然都能被看到）。
 */
export function reduceLog(entries: AnyLogEntry[]): LogEntry[] {
  const tombstones = new Set<string>();
  for (const e of entries) if (isTombstone(e)) tombstones.add(e.targetOpId);
  const seen = new Set<string>();
  const live: LogEntry[] = [];
  for (const e of entries) {
    if (isTombstone(e)) continue;
    if (tombstones.has(e.opId)) continue;
    if (seen.has(e.opId)) continue; // 幂等：同 opId 只保留一次（保留版本号更小者）
    seen.add(e.opId);
    live.push(e);
  }
  return live;
}

/**
 * 客户端把"服务端权威状态"与"本地待同步草稿操作"三方合并：
 * - serverOps：刚拉下来的服务端存活操作（可能包含其他人并发追加的笔迹）
 * - localOps：本地已生成、尚未确认同步成功的操作（离线草稿恢复后也走这里）
 * - confirmedIds：本地已确认被服务端接受的 opId
 *
 * 规则：已确认的本地 op 以服务端为准（服务端没有说明被作者撤回）；
 *      未确认的本地 op 追加在最后（不会因为版本落后而冲掉任何人的笔迹）。
 */
export function mergeClientServer(
  serverOps: LogEntry[],
  localOps: AppendOp[],
  confirmedIds: ReadonlySet<string>,
): { liveOps: LogEntry[]; pendingLocal: AppendOp[] } {
  const serverIds = new Set(serverOps.map((o) => o.opId));
  // 待同步：服务端还没有、且本地也没标记成已确认的操作
  const pendingLocal = localOps.filter(
    (o) => !serverIds.has(o.opId) && !confirmedIds.has(o.opId),
  );
  // 本地已确认但服务器当前快照里没有的操作 = 被撤回，丢弃（不能复活）
  const localTail: LogEntry[] = pendingLocal.map((o, i) => ({
    ...o,
    // 负的临时版本号，保证渲染顺序稳定；服务端接受后替换为正式版本
    version: -1 - i,
  }));
  return { liveOps: [...serverOps, ...localTail], pendingLocal };
}

// ---------- 校验 / 清洗（超长文本、恶意内容、越界坐标） ----------

/** 以 Unicode 码点计数截断，避免 emoji/代理对被劈成半个字符 */
export function clampText(input: unknown, max: number): string {
  const s = typeof input === 'string' ? input : String(input ?? '');
  // 去掉 C0/C1 控制字符，保留 \t \n \r（这里正是有意匹配控制字符）
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  const pts = Array.from(cleaned);
  return pts.slice(0, max).join('').trim();
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function sanitizeStroke(raw: unknown): Stroke | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: '笔迹格式错误' };
  const s = raw as Partial<Stroke>;
  if (typeof s.color !== 'string' || !HEX_COLOR.test(s.color)) {
    return { error: '笔迹颜色非法' };
  }
  if (!Array.isArray(s.points) || s.points.length < 2) {
    return { error: '笔迹至少需要 2 个点' };
  }
  if (s.points.length > LIMITS.MAX_POINTS_PER_STROKE) {
    return { error: `笔迹采样点超过上限 ${LIMITS.MAX_POINTS_PER_STROKE}` };
  }
  const U = LIMITS.FIELD_UNIT;
  const points: [number, number, number][] = [];
  for (const p of s.points) {
    if (!Array.isArray(p) || p.length < 2) return { error: '笔迹点格式错误' };
    const x = Number(p[0]);
    const y = Number(p[1]);
    let w = p[2] === undefined ? 6 : Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w)) {
      return { error: '笔迹坐标必须是数字' };
    }
    if (x < 0 || x > U || y < 0 || y > U) return { error: '笔迹坐标越出视野' };
    w = Math.min(40, Math.max(0.5, w));
    points.push([+x.toFixed(2), +y.toFixed(2), +w.toFixed(2)]);
  }
  return { color: s.color.toLowerCase(), points };
}

export function sanitizeNote(raw: unknown): Note | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: '文本批注格式错误' };
  const n = raw as Partial<Note>;
  const U = LIMITS.FIELD_UNIT;
  const x = Number(n.x);
  const y = Number(n.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > U || y < 0 || y > U) {
    return { error: '批注锚点越界' };
  }
  const text = clampText(n.text, LIMITS.MAX_NOTE_CHARS);
  if (text.length === 0) return { error: '批注文本为空' };
  return { x: +x.toFixed(2), y: +y.toFixed(2), text };
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 生成 v4 UUID（不依赖 crypto 全局可用性，Node 18+/浏览器都有 crypto.randomUUID，这里兜底） */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
