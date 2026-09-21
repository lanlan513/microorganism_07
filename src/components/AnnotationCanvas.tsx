import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AnnotationOp, StrokeOp, TextOp } from '../../shared/annotations';
import { finalizeStroke, downsample, makeText, type RawPoint } from '../utils/annotationGeometry';

export type Tool = 'pen' | 'text';

export interface AnnotationCanvasHandle {
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

interface Props {
  backgroundUrl: string;
  /** 已确认笔迹（自己同步过的 + 别人追加的） */
  committedOps: AnnotationOp[];
  /** 本地未提交笔迹（半受控：撤销/重做直接产出新数组交给父级） */
  pendingOps: AnnotationOp[];
  meta?: Map<string, { authorId?: string; authorName: string; retracted: boolean; hidden: boolean }>;
  color: string;
  baseWidth: number;
  tool: Tool;
  readOnly?: boolean;
  onChange?: (localOps: AnnotationOp[]) => void;
}

/* --------------------------- 变宽贝塞尔带状笔迹 --------------------------- */

/**
 * 在单位坐标系 (0..1)^2 中绘制一条变宽笔迹：
 * 中点二次贝塞尔做平滑，沿曲线两侧按各点宽度偏移构造带状填充路径。
 */
function traceVariableWidthPath(ctx: CanvasRenderingContext2D, s: StrokeOp): void {
  const pts = s.points.map((p) => ({ x: p.x, y: p.y, w: s.width * p.p }));
  if (pts.length < 2) return;

  const normals = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    return { nx: -dy / len, ny: dx / len };
  });

  // 中点节点（位置 + 宽度 + 相邻法线平均后的平滑法线）
  const mids = [] as { x: number; y: number; w: number; nx: number; ny: number }[];
  for (let i = 1; i < pts.length; i++) {
    const a = normals[i - 1];
    const b = normals[i];
    const nx = a.nx + b.nx;
    const ny = a.ny + b.ny;
    const nl = Math.hypot(nx, ny) || 1;
    mids.push({
      x: (pts[i - 1].x + pts[i].x) / 2,
      y: (pts[i - 1].y + pts[i].y) / 2,
      w: (pts[i - 1].w + pts[i].w) / 2,
      nx: nx / nl,
      ny: ny / nl,
    });
  }

  const right = (m: (typeof mids)[number]): [number, number] => [
    m.x + m.nx * (m.w / 2),
    m.y + m.ny * (m.w / 2),
  ];
  const left = (m: (typeof mids)[number]): [number, number] => [
    m.x - m.nx * (m.w / 2),
    m.y - m.ny * (m.w / 2),
  ];

  ctx.beginPath();
  ctx.moveTo(...right(mids[0]));
  for (let i = 1; i < mids.length; i++) {
    const p = pts[i];
    ctx.quadraticCurveTo(
      p.x + normals[i].nx * (p.w / 2),
      p.y + normals[i].ny * (p.w / 2),
      ...right(mids[i]),
    );
  }
  const last = pts[pts.length - 1];
  ctx.arc(last.x, last.y, last.w / 2, 0, Math.PI, false); // 末端半圆
  for (let i = mids.length - 1; i >= 1; i--) {
    const p = pts[i];
    ctx.quadraticCurveTo(
      p.x - normals[i].nx * (p.w / 2),
      p.y - normals[i].ny * (p.w / 2),
      ...left(mids[i - 1]),
    );
  }
  ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, Math.PI, 0, false); // 起端半圆
  ctx.closePath();
  ctx.fillStyle = s.color;
  ctx.fill();
}

function drawStrokeFallback(ctx: CanvasRenderingContext2D, s: StrokeOp): void {
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
  ctx.lineWidth = s.width * 0.7;
  ctx.strokeStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/* -------------------------------- 组件 -------------------------------- */

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, Props>(function AnnotationCanvas(
  { backgroundUrl, committedOps, pendingOps, meta, color, baseWidth, tool, readOnly, onChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [redoStack, setRedoStack] = useState<AnnotationOp[]>([]);
  const [histSize, setHistSize] = useState(0);

  // 进行中的笔画（不走 React state，高频移动直接画 canvas）
  const drawingRef = useRef<{ active: boolean; raw: RawPoint[]; hasRealPressure: boolean; pointerId: number }>({
    active: false,
    raw: [],
    hasRealPressure: false,
    pointerId: -1,
  });
  const [textBox, setTextBox] = useState<{ x: number; y: number; value: string } | null>(null);

  useEffect(() => setHistSize(pendingOps.length), [pendingOps]);

  /* ------------------------------- 尺寸 / DPR ------------------------------- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* --------------------------------- 渲染 --------------------------------- */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    // 画布按设备像素比缩放：高分屏/手写屏不发虚
    const dpr = Math.min(window.devicePixelRatio || 1, 4);
    const W = Math.round(size.w * dpr);
    const H = Math.round(size.h * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    // 单位坐标系：画布宽 = 1（正方形），矢量笔迹与分辨率无关
    ctx.save();
    ctx.scale(size.w, size.w);

    const drawOne = (op: AnnotationOp, ghost = false) => {
      ctx.save();
      if (ghost) ctx.globalAlpha = 0.3;
      if (op.type === 'stroke') {
        if (op.points.length >= 3) traceVariableWidthPath(ctx, op);
        else drawStrokeFallback(ctx, op);
      } else {
        const t = op as TextOp;
        ctx.font = `600 ${t.size}px ui-monospace, SFMono-Regular, monospace`;
        ctx.fillStyle = t.color;
        ctx.textBaseline = 'top';
        const maxW = 0.6;
        let line = '';
        let yy = t.y;
        const lh = t.size * 1.25;
        for (const ch of t.text) {
          if (ctx.measureText(line + ch).width > maxW && line) {
            ctx.fillText(line, t.x, yy);
            line = ch;
            yy += lh;
          } else line += ch;
        }
        ctx.fillText(line, t.x, yy);
      }
      ctx.restore();
    };

    const drawRetractMark = (op: AnnotationOp) => {
      if (op.type !== 'stroke' || !op.points.length) return;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = '#ff5c5c';
      ctx.lineWidth = 0.0022;
      const p0 = op.points[0];
      const p1 = op.points[op.points.length - 1];
      ctx.beginPath();
      ctx.moveTo(p0.x - 0.02, p0.y - 0.02);
      ctx.lineTo(p1.x + 0.02, p1.y + 0.02);
      ctx.moveTo(p0.x - 0.02, p0.y + 0.02);
      ctx.lineTo(p1.x + 0.02, p1.y - 0.02);
      ctx.stroke();
      ctx.restore();
    };

    for (const op of committedOps) {
      const m = meta?.get(op.id);
      drawOne(op, !!(m?.retracted || m?.hidden));
      if (m?.retracted || m?.hidden) drawRetractMark(op);
    }
    for (const op of pendingOps) drawOne(op);
    ctx.restore();
  }, [size, committedOps, pendingOps, meta]);

  useEffect(() => {
    paint();
  }, [paint]);

  /* -------------------------------- 撤销 / 重做 -------------------------------- */
  // 同步成功后父级会把 pendingOps 清空（或被并入 committed），此时清掉重做栈
  useEffect(() => {
    if (pendingOps.length === 0) setRedoStack([]);
  }, [pendingOps]);

  useImperativeHandle(
    ref,
    () => ({
      undo: () => {
        if (!pendingOps.length) return;
        const last = pendingOps[pendingOps.length - 1];
        setRedoStack((r) => [...r, last]);
        onChange?.(pendingOps.slice(0, -1));
      },
      redo: () => {
        setRedoStack((r) => {
          if (!r.length) return r;
          const op = r[r.length - 1];
          onChange?.([...pendingOps, op]);
          return r.slice(0, -1);
        });
      },
      canUndo: () => pendingOps.length > 0,
      canRedo: () => redoStack.length > 0,
    }),
    [pendingOps, redoStack, onChange],
  );

  /* -------------------------------- 指针采集 -------------------------------- */
  const toUnit = (e: React.PointerEvent): RawPoint => {
    const rect = canvasRef.current!.getBoundingClientRect();
    // 触摸/手写笔/鼠标统一走 Pointer Events；pressure===0.5 是浏览器对无压感设备的默认值
    const real = e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5;
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.width,
      pressure: real ? e.pressure : 0,
      t: e.timeStamp,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    if (tool === 'text') {
      const p = toUnit(e);
      setTextBox({ x: p.x, y: p.y, value: '' });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const real = e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5;
    drawingRef.current = { active: true, raw: [toUnit(e)], hasRealPressure: real, pointerId: e.pointerId };
  };

  const previewLiveStroke = () => {
    const d = drawingRef.current;
    paint(); // 已提交 + pending 先画好
    const canvas = canvasRef.current;
    if (!canvas || !d.active) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(size.w, size.w);
    ctx.beginPath();
    ctx.moveTo(d.raw[0].x, d.raw[0].y);
    for (let i = 1; i < d.raw.length; i++) ctx.lineTo(d.raw[i].x, d.raw[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = baseWidth * 0.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d.active || d.pointerId !== e.pointerId) return;
    d.raw.push(toUnit(e));
    previewLiveStroke();
  };

  const finishStroke = () => {
    const d = drawingRef.current;
    if (!d.active) return;
    d.active = false;
    if (d.raw.length >= 2) {
      const points = downsample(d.raw);
      if (points.length >= 2) {
        const op = finalizeStroke(points, color, baseWidth, d.hasRealPressure);
        setRedoStack([]);
        onChange?.([...pendingOps, op]);
        return;
      }
    }
    paint();
  };

  const commitText = () => {
    if (!textBox) return;
    const value = textBox.value.trim();
    if (value) {
      const op = makeText(textBox.x, textBox.y, value.slice(0, 300), 0.03, color);
      setRedoStack([]);
      onChange?.([...pendingOps, op]);
    }
    setTextBox(null);
  };

  return (
    <div
      ref={wrapRef}
      className="relative w-full aspect-square rounded-2xl overflow-hidden border border-white/15 select-none"
      style={{ touchAction: 'none', background: '#07110f' }}
    >
      <img
        src={backgroundUrl}
        alt="标本"
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        draggable={false}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ touchAction: 'none', cursor: readOnly ? 'default' : tool === 'text' ? 'text' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onPointerLeave={(e) => {
          if (drawingRef.current.active && e.buttons === 0) finishStroke();
        }}
      />
      {textBox && (
        <textarea
          autoFocus
          value={textBox.value}
          onChange={(e) => setTextBox({ ...textBox, value: e.target.value.slice(0, 300) })}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitText();
            }
            if (e.key === 'Escape') setTextBox(null);
          }}
          placeholder="写批注，Enter 确认"
          className="absolute z-20 min-w-[120px] max-w-[60%] bg-black/75 border border-teal-300/60 rounded px-2 py-1 text-sm text-white outline-none resize-none"
          style={{ left: textBox.x * size.w, top: textBox.y * size.w, fontSize: Math.max(12, size.w * 0.03) }}
          rows={2}
        />
      )}
      {readOnly && <div className="absolute top-2 left-2 text-[10px] text-white/40 bg-black/50 px-2 py-0.5 rounded">只读</div>}
      {/* 撤销/重做步数（≥20 步要求） */}
      <div className="absolute bottom-2 right-2 text-[10px] text-white/35 bg-black/45 px-2 py-0.5 rounded font-mono">
        撤销栈 {histSize} / 重做栈 {redoStack.length}
      </div>
    </div>
  );
});
