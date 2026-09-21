import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Heart, Copy, BadgeCheck, Clock, GitFork, ArrowLeft, Plus } from 'lucide-react';
import { annotationApi, ApiError } from '../utils/annotationApi';
import { useAppStore } from '../store/useAppStore';
import type { CardSummary } from '../../shared/annotations';

export function CorridorPage() {
  const { specimenId } = useParams();
  const sid = specimenId ? Number(specimenId) : undefined;
  const { microbe, fetchMicrobeById } = useAppStore();
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    if (sid) void fetchMicrobeById(sid);
  }, [sid, fetchMicrobeById]);

  const reload = () => {
    setLoading(true);
    annotationApi
      .listCorridor(sid)
      .then(setCards)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(reload, [sid]);

  const like = async (c: CardSummary) => {
    setActing(c.id);
    try {
      const r = await annotationApi.like(c.id);
      setCards((list) => list.map((x) => (x.id === c.id ? { ...x, likeCount: r.likeCount, liked: r.liked } : x)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(null);
    }
  };

  const fork = async (c: CardSummary) => {
    setActing(c.id);
    try {
      const r = await annotationApi.fork(c.id);
      window.location.href = `/studio/${c.specimenId}/${r.id}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '复刻失败');
      setActing(null);
    }
  };

  return (
    <div className="container mx-auto px-6 pt-32 pb-20 max-w-6xl">
      <Link
        to={sid ? `/microbe/${sid}` : '/'}
        className="inline-flex items-center gap-2 font-mono text-sm text-white/50 hover:text-teal-300 mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> {sid ? '返回标本页' : '返回首页'}
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4 mb-10">
        <div>
          <span className="font-mono text-xs tracking-[0.3em] text-teal-300/70 block mb-2">
            PUBLIC CORRIDOR
          </span>
          <h1 className="font-display text-4xl md:text-5xl font-bold text-white">
            公共走廊{sid && microbe ? ` · ${microbe.name}视野` : ''}
          </h1>
          <p className="text-white/50 text-sm mt-2">
            这里只挂「已通过审核」的讲解卡片。点赞在服务端按用户去重；每张卡都能复刻到自己的标本页继续画。
          </p>
        </div>
        {sid && (
          <Link
            to={`/studio/${sid}`}
            className="px-4 py-2.5 rounded-xl bg-teal-400/20 border border-teal-300/40 text-teal-100 text-sm flex items-center gap-2 hover:bg-teal-400/30"
          >
            <Plus className="w-4 h-4" /> 我也圈一张
          </Link>
        )}
      </div>

      {loading && <div className="text-white/50">加载中…</div>}
      {error && <div className="text-red-300 text-sm mb-4">{error}</div>}
      {!loading && cards.length === 0 && (
        <div className="glass-card p-12 text-center text-white/40">
          这个视野还没有公开卡片。{sid && <Link className="text-teal-300" to={`/studio/${sid}`}> 来画第一张 →</Link>}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-5">
        {cards.map((c) => (
          <div key={c.id} className="glass-card p-6 flex flex-col">
            <div className="flex items-start justify-between gap-3">
              <Link to={`/cards/${c.id}`} className="block group">
                <h3 className="font-display text-xl font-semibold text-white group-hover:text-teal-300 transition-colors">
                  {c.title}
                </h3>
                <p className="text-white/40 text-xs mt-1 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {new Date(c.updatedAt).toLocaleString()} · {c.authorName}
                </p>
              </Link>
              <span className="shrink-0 text-[10px] px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 flex items-center gap-1">
                <BadgeCheck className="w-3 h-3" /> 已过审
              </span>
            </div>
            <p className="text-white/70 text-sm leading-6 mt-3 whitespace-pre-line line-clamp-3">{c.note}</p>
            <div className="text-[11px] text-white/35 mt-3 font-mono">
              {c.opCount} 条矢量批注 · v{c.version}
              {c.forkedFrom && (
                <span className="ml-2 inline-flex items-center gap-0.5">
                  <GitFork className="w-3 h-3" /> 复刻卡
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-4 pt-4 border-t border-white/5">
              <button
                onClick={() => void like(c)}
                disabled={acting === c.id}
                className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border transition-colors ${
                  c.liked
                    ? 'border-pink-400/50 bg-pink-400/15 text-pink-300'
                    : 'border-white/10 text-white/60 hover:text-pink-300'
                }`}
              >
                <Heart className={`w-4 h-4 ${c.liked ? 'fill-pink-300' : ''}`} /> {c.likeCount}
              </button>
              <button
                onClick={() => void fork(c)}
                disabled={acting === c.id}
                className="px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border border-white/10 text-white/60 hover:text-teal-300"
              >
                <Copy className="w-4 h-4" /> 复刻继续画
              </button>
              <Link
                to={`/studio/${c.specimenId}/${c.id}`}
                className="px-3 py-1.5 rounded-lg text-sm border border-white/10 text-white/60 hover:text-teal-300 ml-auto"
              >
                在同一视野追加
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
