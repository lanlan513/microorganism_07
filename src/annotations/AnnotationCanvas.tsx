import { useEffect, useRef } from 'react';
import { DrawingEngine, type ToolMode } from './drawingEngine';
import type { Stroke } from '../../shared/annotation';

interface Props {
  strokes: Stroke[];
  mode: ToolMode;
  color: string;
  onStroke: (s: Stroke) => void;
  onNoteTap: (x: number, y: number) => void;
}

/** 矢量笔迹画布：DPR 自适应、压感/速度笔锋、贝塞尔平滑、触摸+手写笔 */
export function AnnotationCanvas({ strokes, mode, color, onStroke, onNoteTap }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DrawingEngine | null>(null);
  // 用 ref 把最新回调喂给引擎，避免频繁重建事件监听
  const cbRef = useRef({ onStroke, onNoteTap });
  cbRef.current = { onStroke, onNoteTap };

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new DrawingEngine(canvasRef.current, {
      onStroke: (s) => cbRef.current.onStroke(s),
      onNoteTap: (x, y) => cbRef.current.onNoteTap(x, y),
    });
    engineRef.current = engine;
    return () => engine.dispose();
  }, []);

  useEffect(() => {
    engineRef.current?.setStrokes(strokes);
  }, [strokes]);

  useEffect(() => {
    engineRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    engineRef.current?.setColor(color);
  }, [color]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      aria-label="标注画布"
    />
  );
}
