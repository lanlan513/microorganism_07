import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Heart, Copy, PenLine, BadgeCheck, Clock, Ban, Trash2, GitBranch } from 'lucide-react';
import { annotationApi, getIdentity } from './api';
import { CardCanvas } from './CardCanvas';
import { api as microbeApi } from '../utils/api';
import type { Microbe } from '../../shared/types';
import { isNoteOp, type CardDetail } from '../../shared/annotation';

const STATUS_UI = {
  approved: { icon: BadgeCheck, text: '已通过审核 · 公开展示', cls: 'text-glow-primary border-glow-primary/40' },
  pending: { icon: Clock, text: '等待审核中（仅作者可见）', cls: 'text-spore-orange border-spore-orange/40' },
  rejected: { icon: Ban, text: '未通过审核', cls: 'text-glow-red border-glow-red/40' },
  withdrawn: { icon: Trash2, text: '作者已撤回', cls: 'text-text-muted border-white/20' },
} as const;

export function CardDetailPage() {
  const { cardId } = useParams<{ cardId: string }>();
  const navigate = useNavigate();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [microbe, setMicrobe] = useState<Microbe | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const me = getIdentity();

  const load = useCallback(async () => {
    if (!cardId) return;
    try {
      const r = await annotationApi.getCard(cardId);
      setCard(r.data);
      const m = await microbeApi.getMicrobeById(r.data.specimenId).catch(() => null);
      setMicrobe(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, [cardId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleLike = async () => {
    if (!card || busy) return;
    setBusy(true);
    try {
      const r = await annotationApi.like(card.id, !card.likedByMe);
      setCard({ ...card, likeCount: r.data.likeCount, likedByMe: r.data.likedByMe });
    } finally {
      setBusy(false);
    }
  };

  const fork = async () => {
    if (!card) return;
    setBusy(true);
    try {
      const r = await annotationApi.fork(card.id);
      navigate(`/studio/card/${r.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '复刻失败');
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="container mx-auto px-6 pt-32 text-center">
        <p className="mb-4 text-glow-red">{error}</p>
        <Link to="/gallery" className="btn-primary inline-flex"><ArrowLeft className="h-4 w-4" /> 回走廊</Link>
      </div>
    );
  }
  if (!card) {
    return <div className="container mx-auto px-6 pt-32 text-text-muted">加载中…</div>;
  }

  const status = STATUS_UI[card.status];
  const StatusIcon = status.icon;
  const mine = card.authorId === me.userId;

  return (
    <div className="container mx-auto px-4 pb-20 pt-28 lg:px-6">
      <Link to="/gallery" className="mb-5 inline-flex items-center gap-2 text-sm text-text-muted hover:text-glow-primary">
        <ArrowLeft className="h-4 w-4" /> 回公共走廊
      </Link>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <CardCanvas ops={card.liveOps} backgroundUrl={microbe?.imageUrl} />
          <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={toggleLike}
              disabled={busy || card.status !== 'approved'}
              className={`flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm transition-all disabled:opacity-40 ${
                card.likedByMe
                  ? 'border-glow-red/50 bg-glow-red/10 text-glow-red'
                  : 'border-white/15 text-text-light hover:border-glow-red/40'
              }`}
            >
              <Heart className={`h-4 w-4 ${card.likedByMe ? 'fill-current' : ''}`} />
              {card.likedByMe ? '已点赞' : '点赞'} · {card.likeCount}
            </button>
            <Link
              to={`/studio/card/${card.id}`}
              className="flex items-center gap-2 rounded-full border border-glow-primary/40 bg-glow-primary/10 px-5 py-2.5 text-sm text-glow-primary hover:bg-glow-primary/20"
            >
              <PenLine className="h-4 w-4" /> 在同一视野追加批注
            </Link>
            <button
              onClick={fork}
              disabled={busy || card.status !== 'approved'}
              className="flex items-center gap-2 rounded-full border border-glow-purple/40 px-5 py-2.5 text-sm text-glow-purple hover:bg-glow-purple/10 disabled:opacity-40"
            >
              <Copy className="h-4 w-4" /> 复刻到我的标本页
            </button>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="glass-card p-6">
            <div className="mb-2 flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${status.cls}`}>
                <StatusIcon className="h-3.5 w-3.5" /> {status.text}
              </span>
            </div>
            <h1 className="font-display text-2xl text-text-light">{card.title}</h1>
            <p className="mt-1 text-xs text-text-muted">
              {microbe?.name ?? `标本 #${card.specimenId}`} · {card.authorName}
            </p>
            {card.forkedFrom && (
              <p className="mt-2 flex items-center gap-1 text-[11px] text-glow-purple">
                <GitBranch className="h-3 w-3" /> 复刻自 <Link to={`/cards/${card.forkedFrom}`} className="underline">另一张讲解卡片</Link>
              </p>
            )}
            {card.reviewNote && <p className="mt-3 rounded-lg bg-white/5 p-2 text-xs text-text-muted">审核备注：{card.reviewNote}</p>}
          </div>

          <div className="glass-card p-5">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">讲解批注</h3>
            <ul className="space-y-3">
              {card.liveOps
                .filter(isNoteOp)
                .map((o) => (
                  <li key={o.opId} className="rounded-xl border border-glow-primary/15 bg-background-deep/50 p-3">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-light">{o.payload.note.text}</p>
                    <p className="mt-1 text-[10px] text-text-muted">— {o.authorName} · v{o.version}</p>
                  </li>
                ))}
              {card.liveOps.every((o) => o.payload.kind === 'stroke') && (
                <li className="text-xs text-text-muted">这张卡片只有圈划笔迹，没有文字批注。</li>
              )}
            </ul>
          </div>

          <div className="glass-card p-5 text-[11px] leading-relaxed text-text-muted">
            <p>存活标注 {card.liveOps.length} 条 · 日志版本 v{card.version}</p>
            <p className="mt-1">
              两个人同时追加时，服务端用版本号裁决先后：后提交者收到 409 和对方全部笔迹，
              客户端合并后重放，双方笔迹都会保留。运行 <code className="text-glow-primary">node scripts/conflict-demo.mjs</code> 可复现。
            </p>
            {mine && (
              <button
                onClick={async () => {
                  if (confirm('撤回整张卡片？')) {
                    await annotationApi.withdrawCard(card.id);
                    navigate('/gallery?tab=mine');
                  }
                }}
                className="mt-3 flex items-center gap-1.5 text-glow-red hover:underline"
              >
                <Trash2 className="h-3.5 w-3.5" /> 撤回这张卡片
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
