import type { AnnotationOp, CardEvent, StrokeOp, StrokePoint, TextOp } from '../../shared/annotations';
import { genId } from '../../shared/annotations';

/**
 * 客户端笔迹几何：
 * - 坐标全部归一化（0..1），与设备像素比/画布尺寸无关；
 * - 采点做距离抽点（体积压缩）；
 * - 笔锋宽度 = 压感 + 速度混合驱动；
 * - 用二次贝塞尔（中点算法）做平滑。
 */

const MIN_DIST = 0.0018; // 归一化最小采样间距，约 1.8‰ 画布宽

export interface RawPoint {
  x: number;
  y: number;
  /** 硬件压感；拿不到（触摸/鼠标）时给 0 */
  pressure: number;
  t: number;
}

export function downsample(raw: RawPoint[]): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ x: p.x, y: p.y, p: p.pressure, t: p.t });
      continue;
    }
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (dx * dx + dy * dy >= MIN_DIST * MIN_DIST || p === raw[raw.length - 1]) {
      out.push({ x: p.x, y: p.y, p: p.pressure, t: p.t });
    }
  }
  return out;
}

/**
 * 速度驱动压感：画得快 → 细，画得慢/停顿 → 粗；
 * 硬件压感存在（手写笔，pressure 不为 0.5 默认值）时以压感为主、速度为辅。
 */
export function finalizeStroke(
  points: StrokePoint[],
  color: string,
  baseWidth: number,
  hasRealPressure: boolean,
): StrokeOp {
  const n = points.length;
  const speeds = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1, points[i].t - points[i - 1].t);
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    speeds[i] = d / dt; // 归一化距离/ms
  }
  const out = points.map((p, i) => {
    // 速度因子 1（慢）→ 0.25（快）
    const speedFactor = Math.max(0.25, 1 - Math.min(1, speeds[i] / 0.004));
    let width01: number;
    if (hasRealPressure) {
      width01 = 0.35 + 0.65 * p.p * (0.7 + 0.3 * speedFactor);
    } else {
      width01 = 0.45 + 0.55 * speedFactor;
    }
    return { ...p, p: Math.round(width01 * 1000) / 1000 };
  });
  // 起止处自然收锋
  if (out.length > 2) {
    const taper = Math.min(6, Math.floor(out.length / 3));
    for (let i = 0; i < taper; i++) {
      const k = (i + 1) / (taper + 1);
      out[i].p *= k;
      out[out.length - 1 - i].p *= k;
    }
  }
  return { id: genId(), type: 'stroke', color, width: baseWidth, points: out };
}

export function makeText(x: number, y: number, text: string, size: number, color: string): TextOp {
  return { id: genId(), type: 'text', x, y, text, size, color };
}

/* --------------------------- 服务端事件 → 本地状态 --------------------------- */

export interface AppliedState {
  /** 服务端已确认的笔迹（含别人的），op.id 去重 */
  serverOps: AnnotationOp[];
  serverOpMeta: Map<
    string,
    { authorId: string; authorName: string; retracted: boolean; hidden: boolean; v: number }
  >;
  version: number;
}

/**
 * 把增量事件追加到本地状态（合并，而非覆盖）：
 * - add：按 id 去重，缺失才插入，保持版本顺序；
 * - retract/hide：标记已有笔迹，不从数组物理删除（撤回方/作者仍可在 UI 看到痕迹）；
 * - status：只更新版本。
 * 离线恢复后拿到的 since=本地version 增量同样走这里，因此不会冲掉别人笔迹。
 */
export function applyEvents(state: AppliedState, events: CardEvent[]): AppliedState {
  const serverOps = [...state.serverOps];
  const serverOpMeta = new Map(state.serverOpMeta);
  let version = state.version;

  for (const e of events) {
    if (e.v <= version) continue;
    version = e.v;
    if (e.kind === 'add') {
      const existing = serverOpMeta.get(e.record.id);
      if (existing) {
        serverOpMeta.set(e.record.id, {
          ...existing,
          retracted: !!e.record.retracted,
          hidden: !!e.record.hidden,
        });
        continue;
      }
      serverOps.push(e.record.op);
      serverOpMeta.set(e.record.id, {
        authorId: e.record.authorId,
        authorName: e.record.authorName,
        retracted: !!e.record.retracted,
        hidden: !!e.record.hidden,
        v: e.v,
      });
    } else if (e.kind === 'retract-op') {
      const m = serverOpMeta.get(e.opId);
      if (m) serverOpMeta.set(e.opId, { ...m, retracted: true });
    } else if (e.kind === 'hide-op') {
      const m = serverOpMeta.get(e.opId);
      if (m) serverOpMeta.set(e.opId, { ...m, hidden: true });
    }
    // status 事件只需推进 version
  }
  return { serverOps, serverOpMeta, version };
}

export function emptyState(version = 0): AppliedState {
  return { serverOps: [], serverOpMeta: new Map(), version };
}
