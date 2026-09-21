import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Heart, Copy, ShieldQuestion, PlusCircle, RefreshCw, BadgeCheck, Clock } from 'lucide-react';
import { annotationApi, isModeratorMode, setModeratorMode } from './api';
import { CardCanvas } from './CardCanvas';
import { api as microbeApi } from '../utils/api';
import type { Microbe } from '../../shared/types';
import type { CardSummary } from '../../shared/annotation';

type Tab = 'approved' | 'mine' | 'pending';

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  approved: { text: '已通过', cls: 'text-glow-primary border-glow-primary/40' },
  pending: { text: '待审核', cls: 'text-spore-orange border-spore-orange/40' },
  rejected: { text: '已驳回', cls: 'text-glow-red border-glow-red/40' },
  withdrawn: { text: '已撤回', cls: 'text-text-muted border-white/20' },
};

export function GalleryPage() {
  const [search] = useSearchParams();
  const specimenFilter = search.get('specimen');
  const [tab, setTab] = useState<Tab>('approved');
  const [items, setItems] = useState<CardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [microbes, setMicrobes] = useState<Record<number, Microbe>>({});
  const [modMode, setModMode] = useState(isModeratorMode());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = tab === 'mine' ? 'mine' : tab;
      const r = await annotationApi.listCards({
        status,
        specimenId: specimenFilter ? Number(specimenFilter) : undefined,
        limit: 50,
      });
      setItems(r.data.items);
      const ids = [...new Set(r.data.items.map((i) => i.specimenId))];
      const entries = await Promise.all(
        ids.map(async (id) => [id, await microbeApi.getMicrobeById(id).catch(() => null)] as const),
      );
      setMicrobes(Object.fromEntries(entries.filter(([, m]) => m).map(([id, m]) => [id, m!])));
    } finally {
      setLoading(false);
    }
  }, [tab, specimenFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // 列表只含摘要，不含笔迹；缩略图在进入视口时才懒加载详情（见 CardTile）

  const pendingCount = useMemo(() => items.filter((i) => i.status === 'pending').length, [items]);

  return (
    <div className="container mx-auto px-4 pb-20 pt-28 lg:px-6">
      <header className="mb-8">
        <h1 className="font-display text-4xl text-text-light">
          公共<span className="text-glow-primary">走廊</span>
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-text-muted">
          每张讲解卡片都是同一片显微镜视野上的矢量笔迹与批注：可以点赞、在同一视野追加批注，
          也能把别人的标注复刻到自己的标本页继续画。公开卡片均带审核状态。
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <TabButton active={tab === 'approved'} onClick={() => setTab('approved')} icon={<BadgeCheck className="h-4 w-4" />}>
          已通过
        </TabButton>
        <TabButton active={tab === 'mine'} onClick={() => setTab('mine')} icon={<Clock className="h-4 w-4" />}>
          我的卡片
        </TabButton>
        {modMode && (
          <TabButton active={tab === 'pending'} onClick={() => setTab('pending')} icon={<ShieldQuestion className="h-4 w-4" />}>
            审核队列 {pendingCount > 0 && <span className="ml-1 rounded-full bg-spore-orange px-1.5 text-[10px] text-black">{pendingCount}</span>}
          </TabButton>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted">
            <input
              type="checkbox"
              checked={modMode}
              onChange={(e) => {
                const key = e.target.checked ? window.prompt('输入审核员密钥（默认 demo-mod-key）') || '' : '';
                if (e.target.checked && !key) {
                  e.target.checked = false;
                  return;
                }
                setModeratorMode(e.target.checked, key);
                setModMode(e.target.checked);
              }}
              className="accent-[#00ffc8]"
            />
            审核员模式
          </label>
          <button onClick={load} className="rounded-full border border-white/10 p-2 text-text-muted hover:text-glow-primary" title="刷新">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {specimenFilter && (
            <Link
              to={`/studio/${specimenFilter}`}
              className="flex items-center gap-1.5 rounded-full border border-glow-primary/40 px-4 py-2 text-xs text-glow-primary hover:bg-glow-primary/10"
            >
              <PlusCircle className="h-4 w-4" /> 在这个标本上开画
            </Link>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-80 animate-pulse rounded-2xl bg-background-card/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-white/10 p-16 text-center text-text-muted">
          走廊还空着。{specimenFilter ? '去这个标本的视野里画第一张讲解卡片吧。' : '挑一个标本，圈出鞭毛、标出分裂中的细胞。'}
          {specimenFilter && (
            <div className="mt-4">
              <Link to={`/studio/${specimenFilter}`} className="btn-primary inline-flex">
                <PlusCircle className="h-4 w-4" /> 创建讲解卡片
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((card) => (
            <CardTile key={card.id} card={card} microbe={microbes[card.specimenId]} tab={tab} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors ${
        active ? 'bg-glow-primary/15 text-glow-primary border border-glow-primary/40' : 'border border-white/10 text-text-muted hover:text-text-light'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function CardTile({ card, microbe, tab, onChanged }: { card: CardSummary; microbe?: Microbe; tab: Tab; onChanged: () => void }) {
  // 走廊摘要不含笔迹，预览图懒加载详情（只在悬停/进入视口时取）
  const [ops, setOps] = useState<import('../../shared/annotation').LogEntry[] | null>(null);
  const [ref, setRef] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref || ops) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          annotationApi
            .getCard(card.id)
            .then((r) => setOps(r.data.liveOps))
            .catch(() => setOps([]));
          io.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    io.observe(ref);
    return () => io.disconnect();
  }, [ref, ops, card.id]);

  const moderate = async (decision: 'approved' | 'rejected') => {
    await annotationApi.moderate(card.id, decision, decision === 'rejected' ? '演示驳回' : '');
    onChanged();
  };

  const badge = STATUS_LABEL[card.status];

  return (
    <div ref={setRef} className="group glass-card overflow-hidden p-3 transition-all hover:border-glow-primary/30">
      <Link to={`/cards/${card.id}`}>
        {ops ? <CardCanvas ops={ops} backgroundUrl={microbe?.imageUrl} /> : <div className="aspect-square w-full animate-pulse rounded-2xl bg-background-deep/60" />}
      </Link>
      <div className="p-2">
        <div className="mt-2 flex items-start justify-between gap-2">
          <Link to={`/cards/${card.id}`} className="font-medium text-text-light hover:text-glow-primary">
            {card.title}
          </Link>
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
          <span>
            {microbe?.name ?? `标本 #${card.specimenId}`} · {card.authorName}
          </span>
          <span className="flex items-center gap-1">
            <Heart className={`h-3.5 w-3.5 ${card.likedByMe ? 'fill-glow-red text-glow-red' : ''}`} />
            {card.likeCount}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3 text-[10px] text-text-muted">
          <span>{card.strokeCount} 笔迹</span>
          <span>{card.noteCount} 批注</span>
          <span>v{card.version}</span>
          {card.forkedFrom && (
            <span className="flex items-center gap-0.5 text-glow-purple">
              <Copy className="h-3 w-3" /> 复刻件
            </span>
          )}
        </div>
        {tab === 'pending' && (
          <div className="mt-3 flex gap-2">
            <button onClick={() => moderate('approved')} className="flex-1 rounded-full bg-glow-primary/15 py-1.5 text-xs text-glow-primary hover:bg-glow-primary/25">
              通过
            </button>
            <button onClick={() => moderate('rejected')} className="flex-1 rounded-full bg-glow-red/15 py-1.5 text-xs text-glow-red hover:bg-glow-red/25">
              驳回
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
