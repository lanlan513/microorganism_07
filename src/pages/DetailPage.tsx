import { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Calendar, Ruler, MapPin, Sparkles, Share2, PenLine, Palette } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { MicrobeCard } from '../components/MicrobeCard';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../../shared/types';

export function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const { microbe, related, loading, fetchMicrobeById, fetchRelated } = useAppStore();

  useEffect(() => {
    if (id) {
      const numId = Number(id);
      if (!isNaN(numId)) {
        fetchMicrobeById(numId);
        fetchRelated(numId);
      }
    }
  }, [id, fetchMicrobeById, fetchRelated]);

  if (loading) {
    return (
      <div className="container mx-auto px-6 pt-32">
        <div className="animate-pulse space-y-8">
          <div className="h-8 w-32 bg-background-card rounded" />
          <div className="grid lg:grid-cols-5 gap-12">
            <div className="lg:col-span-2 aspect-square bg-background-card rounded-3xl" />
            <div className="lg:col-span-3 space-y-6">
              <div className="h-12 bg-background-card rounded" />
              <div className="h-6 w-48 bg-background-card rounded" />
              <div className="h-32 bg-background-card rounded-2xl" />
              <div className="h-48 bg-background-card rounded-2xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!microbe) {
    return (
      <div className="container mx-auto px-6 pt-32 text-center">
        <h1 className="font-display text-4xl text-glow-red mb-4">标本不存在</h1>
        <Link to="/" className="btn-primary">
          <ArrowLeft className="w-4 h-4" />
          返回首页
        </Link>
      </div>
    );
  }

  const color = CATEGORY_COLORS[microbe.category];
  const badgeClass = `category-badge-${microbe.category}`;

  return (
    <div className="relative min-h-screen pt-32 pb-16">
      <div
        className="fixed inset-0 pointer-events-none opacity-20"
        style={{
          background: `radial-gradient(ellipse 60% 50% at 30% 10%, ${color}22, transparent), radial-gradient(ellipse 50% 40% at 80% 60%, ${color}15, transparent)`,
        }}
      />

      <div className="container mx-auto px-6 relative z-10">
        <div className="animate-fade-in-up stagger-1 opacity-0 mb-8">
          <Link
            to={`/category/${microbe.category}`}
            className="inline-flex items-center gap-2 font-mono text-sm text-text-muted hover:text-glow-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            返回{CATEGORY_LABELS[microbe.category]}展厅
          </Link>
        </div>

        <div className="grid lg:grid-cols-5 gap-12 lg:gap-16 items-start">
          <div className="lg:col-span-2 animate-fade-in-up stagger-2 opacity-0">
            <div className="relative">
              <div
                className="absolute -inset-8 rounded-full blur-3xl opacity-40"
                style={{ background: `radial-gradient(circle, ${color}44, transparent 70%)` }}
              />
              <div className="relative aspect-square rounded-3xl overflow-hidden border-2 glow-border">
                <img
                  src={microbe.imageUrl}
                  alt={microbe.name}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-transparent to-transparent" />
                <div className="absolute bottom-6 left-6 right-6">
                  <span className={`category-badge ${badgeClass} backdrop-blur-md`}>
                    {CATEGORY_LABELS[microbe.category]}
                  </span>
                </div>
                <div className="absolute top-6 right-6">
                  <span className="font-mono text-sm text-text-light/80 tracking-wider backdrop-blur-sm px-3 py-1 rounded-full bg-background/40">
                    #{String(microbe.id).padStart(3, '0')}
                  </span>
                </div>
              </div>
              {/* 涂鸦共享馆入口 */}
              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  to={`/studio/${microbe.id}`}
                  className="flex flex-1 items-center justify-center gap-2 rounded-full border border-glow-primary/40 bg-glow-primary/10 px-4 py-3 text-sm text-glow-primary transition-all hover:bg-glow-primary/20 hover:shadow-glow"
                >
                  <PenLine className="h-4 w-4" />
                  在这个视野上圈划讲解
                </Link>
                <Link
                  to={`/gallery?specimen=${microbe.id}`}
                  className="flex flex-1 items-center justify-center gap-2 rounded-full border border-white/15 px-4 py-3 text-sm text-text-light transition-all hover:border-glow-primary/40 hover:text-glow-primary"
                >
                  <Palette className="h-4 w-4" />
                  看这个标本的讲解卡片
                </Link>
              </div>
            </div>
          </div>

          <div className="lg:col-span-3 animate-fade-in-up stagger-3 opacity-0">
            <div className="mb-8">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h1
                    className="font-display text-5xl md:text-6xl font-bold text-text-light mb-3 leading-tight"
                    style={{ textShadow: `0 0 40px ${color}40` }}
                  >
                    {microbe.name}
                  </h1>
                  <p className="font-mono text-lg text-text-muted italic">
                    {microbe.scientificName}
                  </p>
                </div>
                <button
                  className="p-3 rounded-full border border-white/10 text-text-muted hover:text-glow-primary hover:border-glow-primary/40 transition-colors"
                  title="分享"
                >
                  <Share2 className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-4 mb-10">
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-2">
                  <Calendar className="w-4 h-4" style={{ color }} />
                  <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-text-muted">
                    发现年份
                  </span>
                </div>
                <p className="font-display text-2xl font-semibold text-text-light">
                  {microbe.discoveredYear}
                </p>
              </div>
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-2">
                  <Ruler className="w-4 h-4" style={{ color }} />
                  <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-text-muted">
                    尺寸大小
                  </span>
                </div>
                <p className="font-display text-xl font-semibold text-text-light leading-tight">
                  {microbe.size}
                </p>
              </div>
              <div className="glass-card p-5">
                <div className="flex items-center gap-3 mb-2">
                  <MapPin className="w-4 h-4" style={{ color }} />
                  <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-text-muted">
                    生存环境
                  </span>
                </div>
                <p className="font-display text-lg font-semibold text-text-light leading-tight">
                  {microbe.habitat}
                </p>
              </div>
            </div>

            <div className="glass-card p-8 mb-10">
              <div className="flex items-center gap-3 mb-5">
                <Sparkles className="w-5 h-5" style={{ color }} />
                <h2 className="font-display text-2xl font-semibold text-text-light">
                  详细介绍
                </h2>
              </div>
              <p className="font-mono text-base text-text-light/90 leading-loose tracking-wide">
                {microbe.description}
              </p>
            </div>

            <div className="glass-card p-8">
              <h2 className="font-display text-2xl font-semibold text-text-light mb-6">
                主要特征
              </h2>
              <div className="flex flex-wrap gap-3">
                {microbe.characteristics.map((char) => (
                  <span
                    key={char}
                    className={`category-badge ${badgeClass} text-sm px-4 py-2`}
                  >
                    {char}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {related.length > 0 && (
          <section className="mt-32 animate-fade-in-up stagger-4 opacity-0">
            <div className="flex items-end justify-between mb-10">
              <div>
                <span
                  className="font-mono text-xs tracking-[0.3em] uppercase block mb-3"
                  style={{ color }}
                >
                  Related Specimens
                </span>
                <h2 className="font-display text-4xl font-semibold text-text-light">
                  同展厅其他标本
                </h2>
              </div>
              <Link
                to={`/category/${microbe.category}`}
                className="hidden md:inline-flex items-center gap-2 font-mono text-sm text-text-muted hover:text-glow-primary transition-colors"
              >
                查看全部
                <ArrowLeft className="w-4 h-4 rotate-180" />
              </Link>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {related.map((m, idx) => (
                <MicrobeCard key={m.id} microbe={m} index={idx} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
