import { useEffect, useRef } from 'react';
import { DrawingEngine } from './drawingEngine';
import { isNoteOp, isStrokeOp, type LogEntry } from '../../shared/annotation';

const U = 1000;

interface Props {
  ops: LogEntry[];
  /** 背景图（标本图） */
  backgroundUrl?: string;
  /** 点击某条批注（详情页用） */
  className?: string;
}

/** 只读矢量预览：服务端存什么笔迹就画什么，永远不是截图 */
export function CardCanvas({ ops, backgroundUrl, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DrawingEngine | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new DrawingEngine(canvasRef.current, {});
    engine.setMode('view');
    engineRef.current = engine;
    return () => engine.dispose();
  }, []);

  useEffect(() => {
    engineRef.current?.setStrokes(ops.filter(isStrokeOp).map((o) => o.payload.stroke));
  }, [ops]);

  return (
    <div className={`relative aspect-square w-full overflow-hidden rounded-2xl border border-glow-primary/15 bg-[#06110f] ${className ?? ''}`}>
      {backgroundUrl && (
        <img
          src={backgroundUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover opacity-55"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-br from-background-deep/30 via-transparent to-background-deep/60" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* 文本批注覆盖层 */}
      {ops
        .filter(isNoteOp)
        .map((o) => {
          const n = o.payload.note;
          return (
            <div
              key={o.opId}
              className="pointer-events-none absolute max-w-[46%] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-glow-primary/30 bg-background-deep/80 px-2 py-1 text-[10px] leading-tight text-text-light backdrop-blur-sm"
              style={{ left: `${(n.x / U) * 100}%`, top: `${(n.y / U) * 100}%` }}
            >
              {n.text}
            </div>
          );
        })}
    </div>
  );
}
