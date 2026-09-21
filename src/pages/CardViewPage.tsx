import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Heart, Copy, PenLine, Undo2, RefreshCw } from 'lucide-react';
import { AnnotationCanvas } from '../components/AnnotationCanvas';
import { annotationApi, ApiError } from '../utils/annotationApi';
import { useAppStore } from '../store/useAppStore';
import { getIdentity } from '../utils/identity';
import { applyEvents, emptyState } from '../utils/annotationGeometry';
import type { CardStatus } from '../../shared/annotations';

export function CardViewPage() {
  const { id } = useParams();
  const cardId = id!;
  const navigate = useNavigate();
  const { microbe, fetchMicrobeById } = useAppStore();
  const me = getIdentity();

  const [state, setState] = useState(() => emptyState(0));
  const [summary, setSummary] = useState<{
    specimenId: number;
    title: string;
    note: string;
    authorId: string;
    authorName: string;
    status: CardStatus;
    likeCount: number;
    liked: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 轮询回调 6s 重建一次，闭包里的 version 会冻结在旧值 → 用 ref 始终拿最新版本号
  const versionRef = useRef(0);
  versionRef.current = state.version;

  const load = useCallback(
    async (since: number) => {
      try {
        const d = await annotationApi.getCard(cardId, since);
        setState((prev) => (since === 0 ? applyEvents(emptyState(0), d.events) : applyEvents(prev, d.events)));
        setSummary({
          specimenId: d.card.specimenId,
          title: d.card.title,
          note: d.note,
          authorId: d.card.authorId,
          authorName: d.card.authorName,
          status: d.status,
          likeCount: d.card.likeCount,
          liked: !!d.card.liked,
        });
      } catch (err) {
        setError(err instanceof ApiError ? `${err.message}（${err.code}）` : (err as Error).message);
      }
    },
    [cardId],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  useEffect(() => {
    if (!summary) return;
    void fetchMicrobeById(summary.specimenId);
    const t = setInterval(() => void load(versionRef.current), 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.specimenId]);

  const like = async () => {
    const r = await annotationApi.like(cardId);
    setSummary((s) => (s ? { ...s, likeCount: r.likeCount, liked: r.liked } : s));
  };

  const retractOp = async (opId: string) => {
    setBusy(true);
    try {
      await annotationApi.retractOp(cardId, opId);
      await load(state.version);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retractCard = async () => {
    if (!confirm('确定撤回整张卡片？撤回后从公共走廊消失（不可在本原型恢复）。')) return;
    setBusy(true);
    try {
      await annotationApi.retract(cardId);
      navigate('/corridor');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="container mx-auto px-6 pt-36 text-center max-w-lg">
        <h1 className="font-display text-3xl text-red-300 mb-3">打不开这张卡</h1>
        <p className="text-white/50 mb-6">{error}</p>
        <Link to="/corridor" className="btn-primary">
          <ArrowLeft className="w-4 h-4" /> 回走廊
        </Link>
      </div>
    );
  }
  if (!summary || !microbe) return <div className="container mx-auto px-6 pt-36 text-white/50">加载中…</div>;

  // 列出笔迹清单（作者可撤回自己的单条标注）
  const opList = state.serverOps.map((op) => {
    const m = state.serverOpMeta.get(op.id)!;
    return {
      id: op.id,
      type: op.type,
      authorId: m.authorId,
      author: m.authorName,
      retracted: m.retracted,
      hidden: m.hidden,
    };
  });

  return (
    <div className="container mx-auto px-4 md:px-6 pt-28 pb-20 max-w-6xl">
      <Link
        to={`/corridor/${summary.specimenId}`}
        className="inline-flex items-center gap-2 font-mono text-sm text-white/50 hover:text-teal-300 mb-5"
      >
        <ArrowLeft className="w-4 h-4" /> 回这个视野的走廊
      </Link>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-6">
        <div>
          <AnnotationCanvas
            backgroundUrl={microbe.imageUrl}
            committedOps={state.serverOps}
            pendingOps={[]}
            meta={state.serverOpMeta}
            color="#fff"
            baseWidth={0.007}
            tool="pen"
            readOnly
          />
          <button
            onClick={() => void load(0)}
            className="mt-2 text-xs text-white/40 hover:text-teal-300 inline-flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> 手动拉取最新批注（当前 v{state.version}）
          </button>
        </div>

        <div className="space-y-4">
          <div className="glass-card p-6">
            <h1 className="font-display text-2xl font-bold text-white">{summary.title}</h1>
            <p className="text-white/40 text-xs mt-1">
              {summary.authorName} · 标本 {microbe.name}
            </p>
            <p className="text-white/85 text-sm leading-7 mt-4 whitespace-pre-line">{summary.note}</p>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => void like()}
                className={`px-4 py-2 rounded-lg text-sm flex items-center gap-2 border ${
                  summary.liked
                    ? 'border-pink-400/50 bg-pink-400/15 text-pink-300'
                    : 'border-white/10 text-white/70 hover:text-pink-300'
                }`}
              >
                <Heart className={`w-4 h-4 ${summary.liked ? 'fill-pink-300' : ''}`} /> {summary.likeCount}
              </button>
              <button
                onClick={async () => {
                  const r = await annotationApi.fork(cardId);
                  navigate(`/studio/${summary.specimenId}/${r.id}`);
                }}
                className="px-4 py-2 rounded-lg text-sm flex items-center gap-2 border border-white/10 text-white/70 hover:text-teal-300"
              >
                <Copy className="w-4 h-4" /> 复刻
              </button>
              <Link
                to={`/studio/${summary.specimenId}/${cardId}`}
                className="px-4 py-2 rounded-lg text-sm flex items-center gap-2 border border-teal-300/30 text-teal-200 bg-teal-400/10 hover:bg-teal-400/20"
              >
                <PenLine className="w-4 h-4" /> 追加批注
              </Link>
            </div>
          </div>

          <div className="glass-card p-5">
            <div className="text-xs text-white/40 tracking-widest mb-3">这个视野上的笔迹（{opList.length}）</div>
            <ul className="space-y-1.5 max-h-56 overflow-auto pr-1">
              {opList.map((o) => (
                <li key={o.id} className="flex items-center justify-between text-xs text-white/60">
                  <span>
                    {o.type === 'stroke' ? '✏️ 笔迹' : '📝 文字'} · {o.author}
                    {o.retracted && <span className="text-red-300/80">（已撤回）</span>}
                    {o.hidden && <span className="text-amber-300/80">（被审核隐藏）</span>}
                  </span>
                  {!o.retracted &&
                    (o.authorId === me.id ? (
                      <button
                        disabled={busy}
                        onClick={() => retractOp(o.id)}
                        className="text-red-300/70 hover:text-red-300 text-[11px]"
                      >
                        撤回
                      </button>
                    ) : (
                      <span className="w-10" />
                    ))}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-white/30 mt-2">
              撤回只对自己的批注生效，采用追加 retract 事件：笔迹仍在事件日志里，但对其他人不可见。
            </p>
          </div>

          {summary.authorId === me.id && summary.status === 'approved' && (
            <button
              onClick={() => void retractCard()}
              disabled={busy}
              className="w-full px-4 py-2.5 rounded-lg text-sm border border-red-400/30 text-red-300/90 hover:bg-red-400/10 inline-flex items-center justify-center gap-2"
            >
              <Undo2 className="w-4 h-4" /> 撤回我发布的整张卡片
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
