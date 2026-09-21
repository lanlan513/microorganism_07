import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Undo2,
  Redo2,
  PenLine,
  Type,
  Eye,
  Send,
  CloudOff,
  Cloud,
  Loader2,
  Copy,
  Trash2,
  Flag,
} from 'lucide-react';
import { api as microbeApi } from '../utils/api';
import type { Microbe } from '../../shared/types';
import { LIMITS, isNoteOp, isStrokeOp, type Note } from '../../shared/annotation';
import { AnnotationCanvas } from './AnnotationCanvas';
import { useAnnotationEditor } from './useAnnotationEditor';
import { annotationApi } from './api';
import type { ToolMode } from './drawingEngine';

const COLORS = ['#00ffc8', '#ff7b29', '#f1c40f', '#e74c3c', '#9b59b6', '#e8f5f2'];

export function StudioPage() {
  const params = useParams<{ specimenId: string; cardId?: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const specimenIdParam = Number(params.specimenId ?? search.get('specimenId'));
  const cardId = params.cardId ?? search.get('cardId');
  const forkFrom = search.get('fork');

  const [microbe, setMicrobe] = useState<Microbe | null>(null);
  const [mode, setMode] = useState<ToolMode>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [noteDraft, setNoteDraft] = useState<{ x: number; y: number; text: string } | null>(null);
  const [toast, setToast] = useState('');

  const { state, addStroke, addNote, undo, redo, setTitle, publish } = useAnnotationEditor({
    specimenId: Number.isFinite(specimenIdParam) ? specimenIdParam : 0,
    cardId,
  });

  const specimenId = state.draft?.specimenId || specimenIdParam;

  useEffect(() => {
    if (!specimenId) return;
    microbeApi.getMicrobeById(specimenId).then(setMicrobe).catch(() => setMicrobe(null));
  }, [specimenId]);

  // fork 参数：进入页面后复刻源卡片（一次性）
  const [forking, setForking] = useState(!!forkFrom);
  useEffect(() => {
    if (!forkFrom) return;
    let cancelled = false;
    annotationApi
      .fork(forkFrom)
      .then((r) => {
        if (cancelled) return;
        navigate(`/studio/card/${r.data.id}`, { replace: true });
      })
      .catch((e) => {
        if (!cancelled) {
          setForking(false);
          flash(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forkFrom]);

  const strokes = useMemo(
    () => state.liveOps.filter(isStrokeOp).map((o) => o.payload.stroke),
    [state.liveOps],
  );

  const notes = state.liveOps.filter(isNoteOp).map((o) => ({ op: o, note: o.payload.note }));
  const myUserId = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('graffiti.identity.v1') || '{}').userId as string;
    } catch {
      return '';
    }
  }, []);

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(''), 3000);
  };

  const saveNote = () => {
    if (!noteDraft) return;
    const text = Array.from(noteDraft.text).slice(0, LIMITS.MAX_NOTE_CHARS).join('').trim();
    if (!text) {
      setNoteDraft(null);
      return;
    }
    const n: Note = { x: noteDraft.x, y: noteDraft.y, text };
    addNote(n);
    setNoteDraft(null);
    setMode('pen');
  };

  const onPublish = async () => {
    const id = await publish();
    if (id) {
      flash('讲解卡片已提交，审核通过后会挂进公共走廊');
      navigate(`/cards/${id}`);
    }
  };

  const onWithdrawOp = async (opId: string) => {
    if (!state.draft?.cardId) return;
    try {
      await annotationApi.withdrawOp(state.draft.cardId, opId);
      flash('已撤回该条标注（追加墓碑，他人合并时也不会复活）');
    } catch (e) {
      flash(e instanceof Error ? e.message : '撤回失败');
    }
  };

  const onWithdrawCard = async () => {
    if (!state.draft?.cardId) return;
    if (!confirm('确定撤回整张卡片？撤回后公共走廊不再展示。')) return;
    await annotationApi.withdrawCard(state.draft.cardId);
    navigate('/gallery');
  };

  if (state.loading || !microbe || forking) {
    return (
      <div className="container mx-auto flex min-h-screen items-center justify-center pt-24 text-text-muted">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> {forking ? '正在复刻他人笔迹到你的标本页…' : '正在打开显微镜视野…'}
      </div>
    );
  }

  const isNew = !state.draft?.cardId;

  return (
    <div className="container mx-auto px-4 pb-16 pt-28 lg:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link to={cardId ? `/cards/${cardId}` : `/microbe/${specimenId}`} className="flex items-center gap-2 text-sm text-text-muted hover:text-glow-primary">
          <ArrowLeft className="h-4 w-4" /> 返回
        </Link>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          {state.syncState === 'offline-queued' ? (
            <span className="flex items-center gap-1 rounded-full border border-spore-orange/40 px-3 py-1 text-spore-orange">
              <CloudOff className="h-3.5 w-3.5" /> {state.syncMessage}
            </span>
          ) : state.syncState === 'syncing' ? (
            <span className="flex items-center gap-1 text-glow-primary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 合并中…
            </span>
          ) : state.syncMessage ? (
            <span className="flex items-center gap-1 text-glow-primary">
              <Cloud className="h-3.5 w-3.5" /> {state.syncMessage}
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* 视野 */}
        <div>
          <div className="relative aspect-square w-full overflow-hidden rounded-3xl border border-glow-primary/20 bg-[#06110f] shadow-[0_0_60px_-15px_rgba(0,255,200,0.25)]">
            <img src={microbe.imageUrl} alt={microbe.name} className="absolute inset-0 h-full w-full object-cover opacity-50" draggable={false} />
            <div className="absolute inset-0 bg-gradient-to-br from-background-deep/30 via-transparent to-background-deep/50" />
            <AnnotationCanvas strokes={strokes} mode={mode} color={color} onStroke={addStroke} onNoteTap={(x, y) => setNoteDraft({ x, y, text: '' })} />

            {/* 已落定的批注（自己待同步的 + 他人的） */}
            {notes.map(({ op, note }) => (
              <div
                key={op.opId}
                className="group absolute max-w-[46%] -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${(note.x / LIMITS.FIELD_UNIT) * 100}%`, top: `${(note.y / LIMITS.FIELD_UNIT) * 100}%` }}
              >
                <div className="rounded-lg border border-glow-primary/30 bg-background-deep/85 px-2 py-1 text-[11px] leading-snug text-text-light backdrop-blur-sm">
                  {note.text}
                  <div className="mt-0.5 text-[9px] text-text-muted">{op.authorName}</div>
                </div>
              </div>
            ))}

            {/* 新建批注输入框 */}
            {noteDraft && (
              <div
                className="absolute z-20 w-56 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${(noteDraft.x / LIMITS.FIELD_UNIT) * 100}%`, top: `${(noteDraft.y / LIMITS.FIELD_UNIT) * 100}%` }}
              >
                <textarea
                  autoFocus
                  value={noteDraft.text}
                  maxLength={LIMITS.MAX_NOTE_CHARS * 2}
                  onChange={(e) => setNoteDraft({ ...noteDraft, text: e.target.value })}
                  onBlur={saveNote}
                  placeholder="写两句讲解（最多500字）"
                  className="w-full rounded-lg border border-glow-primary/50 bg-background-deep/95 p-2 text-xs text-text-light outline-none"
                  rows={3}
                />
                <div className="mt-1 flex justify-end gap-1 text-[10px] text-text-muted">
                  <span>{Array.from(noteDraft.text).length}/{LIMITS.MAX_NOTE_CHARS}</span>
                </div>
              </div>
            )}
          </div>

          {/* 工具条 */}
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-white/5 bg-background-card/70 p-3 backdrop-blur">
            <ToolBtn active={mode === 'pen'} onClick={() => setMode('pen')} icon={<PenLine className="h-4 w-4" />} label="笔迹" />
            <ToolBtn active={mode === 'note'} onClick={() => setMode('note')} icon={<Type className="h-4 w-4" />} label="批注" />
            <ToolBtn active={mode === 'view'} onClick={() => setMode('view')} icon={<Eye className="h-4 w-4" />} label="查看" />
            <div className="mx-2 h-6 w-px bg-white/10" />
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => {
                  setColor(c);
                  setMode('pen');
                }}
                className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${color === c ? 'border-white scale-110' : 'border-white/20'}`}
                style={{ backgroundColor: c }}
                aria-label={`颜色 ${c}`}
              />
            ))}
            <div className="mx-2 h-6 w-px bg-white/10" />
            <button onClick={undo} disabled={!state.canUndo} className="tool-btn disabled:opacity-30" title="撤销（最多100步）">
              <Undo2 className="h-4 w-4" />
            </button>
            <button onClick={redo} disabled={!state.canRedo} className="tool-btn disabled:opacity-30" title="重做">
              <Redo2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 侧栏 */}
        <aside className="space-y-4">
          <div className="glass-card p-5">
            <h2 className="mb-1 font-display text-lg text-text-light">
              {microbe.name} · 讲解卡片
            </h2>
            <p className="mb-4 font-mono text-[10px] uppercase tracking-widest text-text-muted">
              {microbe.scientificName}
            </p>
            {isNew ? (
              <input
                defaultValue={state.draft?.title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="给卡片起个标题，如：鞭毛与二分裂"
                maxLength={LIMITS.MAX_TITLE_CHARS}
                className="mb-3 w-full rounded-lg border border-white/10 bg-background-deep/60 px-3 py-2 text-sm text-text-light outline-none focus:border-glow-primary/50"
              />
            ) : (
              <div className="mb-3 text-sm font-medium text-text-light">{state.draft?.title}</div>
            )}

            <div className="mb-3 rounded-lg border border-white/5 bg-background-deep/50 p-3 text-[11px] leading-relaxed text-text-muted">
              <p>存活笔迹 <span className="text-glow-primary">{state.liveOps.length}</span> 条 · 服务端版本 v{state.draft?.serverVersion ?? 0}</p>
              <p className="mt-1">矢量笔迹以点列存储于服务端，缩放不糊；所有追加按版本号合并，双方笔迹都保留。</p>
            </div>

            {isNew ? (
              <button onClick={onPublish} disabled={state.publishing} className="btn-primary w-full justify-center disabled:opacity-50">
                {state.publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                发布并提交审核
              </button>
            ) : (
              <div className="space-y-2">
                <div className="rounded-lg border border-glow-primary/20 bg-glow-primary/5 p-2 text-[11px] text-glow-primary">
                  画完即自动追加同步；与他人冲突时会收到 409，客户端合并后重放，双方笔迹都在。
                </div>
                {state.draft.authorId === myUserId && (
                  <button onClick={onWithdrawCard} className="flex w-full items-center justify-center gap-2 rounded-full border border-glow-red/30 px-4 py-2 text-xs text-glow-red hover:bg-glow-red/10">
                    <Trash2 className="h-3.5 w-3.5" /> 撤回整张卡片
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 操作列表（可撤回自己的标注） */}
          {state.draft?.cardId && (
            <div className="glass-card max-h-72 overflow-auto p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">标注清单</h3>
              <ul className="space-y-1.5">
                {[...state.liveOps].reverse().map((op) => (
                  <li key={op.opId} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-text-light">
                      {op.payload.kind === 'stroke' ? (
                        <span className="inline-flex items-center gap-1.5"><PenLine className="h-3 w-3" style={{ color: op.payload.stroke.color }} />笔迹 · {op.authorName}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5"><Type className="h-3 w-3" />{op.payload.note.text.slice(0, 18)}</span>
                      )}
                    </span>
                    {op.authorId === myUserId && (
                      <button onClick={() => onWithdrawOp(op.opId)} className="text-text-muted hover:text-glow-red" title="撤回我的标注">
                        <Flag className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="glass-card p-4 text-[10px] leading-relaxed text-text-muted">
            <p className="mb-1 flex items-center gap-1 text-text-light"><Copy className="h-3 w-3" /> 触摸 / 手写笔 / 鼠标均可</p>
            手写笔按压感、触摸按运笔速度改变笔锋；画布按设备像素比渲染。
            撤销/重做各保留 {LIMITS.UNDO_REDO_CAP} 步（要求 ≥{LIMITS.UNDO_REDO_MIN}）。
          </div>
        </aside>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-glow-primary/30 bg-background-card/95 px-5 py-2 text-sm text-glow-primary shadow-glow">
          {toast}
        </div>
      )}
    </div>
  );
}

function ToolBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors ${
        active ? 'bg-glow-primary/15 text-glow-primary' : 'text-text-muted hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
