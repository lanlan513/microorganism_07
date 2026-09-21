/**
 * 手写笔迹引擎（框架无关）
 *
 * - Pointer Events 统一鼠标 / 触摸 / 手写笔；touch-action:none 防止页面滚动
 * - 笔锋粗细：手写笔用 pressure；触摸/鼠标用速度（快细慢粗）融合
 * - 贝塞尔平滑：相邻点取中点做二次贝塞尔，分段 lineWidth 模拟压感笔锋
 * - 设备像素比：canvas 像素尺寸 = CSS 尺寸 * dpr，ctx.setTransform 缩放，不发虚
 * - 输出为字段坐标系（0..1000）的矢量点列，不是位图
 */
import { LIMITS, type Stroke } from '../../shared/annotation';

export interface RawPoint {
  x: number;
  y: number;
  w: number;
  t: number;
}

export type ToolMode = 'pen' | 'note' | 'view';

export interface EngineCallbacks {
  onStroke?: (stroke: Stroke) => void;
  onNoteTap?: (x: number, y: number) => void;
  onDirtyChange?: (drawing: boolean) => void;
}

const U = LIMITS.FIELD_UNIT;
const MIN_W = 1.5; // 字段单位
const MAX_W = 12;
/** 采样最小间距（字段单位），顺手做第一层点数压缩 */
const MIN_DIST = 2.2;

export class DrawingEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: EngineCallbacks;
  private dpr = 1;
  private cssSize = 0;
  private scale = 1; // 1 字段单位 = scale px
  private drawing = false;
  private raw: RawPoint[] = [];
  private color = '#00ffc8';
  mode: ToolMode = 'pen';
  /** 需要渲染的所有已提交笔迹（含他人 + 本地待同步） */
  strokes: Stroke[] = [];

  // 解绑函数
  private disposeFns: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks = {}) {
    this.canvas = canvas;
    this.cb = cb;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    canvas.style.touchAction = 'none';
    this.attach();
    this.resize();
  }

  setColor(c: string) {
    this.color = c;
  }

  setMode(m: ToolMode) {
    this.mode = m;
    this.canvas.style.cursor = m === 'pen' ? 'crosshair' : m === 'note' ? 'text' : 'default';
  }

  setStrokes(strokes: Stroke[]) {
    this.strokes = strokes;
    this.render();
  }

  private toField(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * U;
    const y = ((e.clientY - rect.top) / rect.height) * U;
    return { x: Math.min(U, Math.max(0, x)), y: Math.min(U, Math.max(0, y)) };
  }

  /** 压感 + 速度 -> 笔锋宽度（字段单位） */
  private width(e: PointerEvent, prev: RawPoint | null, x: number, y: number): number {
    const pressureNorm = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    let slowFactor = 0.5;
    if (prev) {
      const dt = Math.max(1, e.timeStamp - prev.t);
      const v = (Math.hypot(x - prev.x, y - prev.y) / dt) * 1000; // 字段单位/秒
      // v≈0 最粗(1)，v>=900 最细(0)
      slowFactor = Math.min(1, Math.max(0, 1 - v / 900));
    }
    const k = 0.65 * pressureNorm + 0.35 * slowFactor;
    return +(MIN_W + (MAX_W - MIN_W) * k).toFixed(2);
  }

  private attach() {
    const c = this.canvas;
    const down = (e: PointerEvent) => {
      const { x, y } = this.toField(e);
      if (this.mode === 'note') {
        e.preventDefault();
        this.cb.onNoteTap?.(x, y);
        return;
      }
      if (this.mode !== 'pen') return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.cb.onDirtyChange?.(true);
      const w = this.width(e, null, x, y);
      this.raw = [{ x, y, w, t: e.timeStamp }];
    };
    const move = (e: PointerEvent) => {
      if (!this.drawing) return;
      e.preventDefault();
      const { x, y } = this.toField(e);
      const prev = this.raw[this.raw.length - 1];
      if (Math.hypot(x - prev.x, y - prev.y) < MIN_DIST) return;
      if (this.raw.length >= LIMITS.MAX_POINTS_PER_STROKE) return;
      this.raw.push({ x, y, w: this.width(e, prev, x, y), t: e.timeStamp });
      this.render();
      this.drawLive();
    };
    const up = (e: PointerEvent) => {
      if (!this.drawing) return;
      this.drawing = false;
      this.cb.onDirtyChange?.(false);
      if (this.raw.length < 2) {
        // 点按也算一个点：补一个极近邻点，形成圆点头
        const p = this.raw[0];
        this.raw.push({ x: p.x + 0.01, y: p.y, w: p.w * 0.9, t: e.timeStamp });
      }
      const stroke: Stroke = {
        color: this.color,
        points: this.raw.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2), p.w] as [number, number, number]),
      };
      this.raw = [];
      this.cb.onStroke?.(stroke); // 父级把它收进状态后会通过 setStrokes 触发重绘
    };

    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    this.disposeFns.push(() => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    });

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(c);
    this.disposeFns.push(() => ro.disconnect());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.cssSize = rect.width;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.scale = (rect.width / U) * this.dpr; // 字段单位 -> 物理像素
    this.render();
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // 之后都用 CSS 像素
    ctx.clearRect(0, 0, this.cssSize, this.cssSize);
    const s = this.cssSize / U; // 字段单位 -> CSS 像素
    ctx.save();
    ctx.scale(s, s); // 切到字段坐标系
    for (const stroke of this.strokes) this.traceStrokeScaled(stroke);
    ctx.restore();
  }

  /** 在字段坐标系里描边：lineWidth 直接用字段单位，无需再乘比例 */
  private traceStrokeScaled(stroke: Stroke) {
    const ctx = this.ctx;
    const pts = stroke.points;
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      ctx.lineWidth = (a[2] + b[2]) / 2;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      if (i < pts.length - 1) {
        const c = pts[i + 1];
        ctx.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
      } else {
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
    }
  }

  private drawLive() {
    // 当前未提交笔画跟随手指；与 render 同样的坐标约定
    const ctx = this.ctx;
    const s = this.cssSize / U;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.scale(s, s);
    this.traceStrokeScaled({ color: this.color, points: this.raw.map((p) => [p.x, p.y, p.w]) });
    ctx.restore();
  }

  dispose() {
    this.disposeFns.forEach((f) => f());
  }
}
