import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldX, EyeOff, ArrowLeft } from 'lucide-react';
import { annotationApi, ApiError } from '../utils/annotationApi';
import type { CardSummary } from '../../shared/annotations';

const TOKEN_KEY = 'mod-token';

export function ModerationPage() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || 'moderator');
  const [authed, setAuthed] = useState(false);
  const [queue, setQueue] = useState<CardSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (t: string) => {
    try {
      const q = await annotationApi.modQueue(t);
      setQueue(q);
      setAuthed(true);
      setError('');
      localStorage.setItem(TOKEN_KEY, t);
    } catch (err) {
      setAuthed(false);
      setError(err instanceof ApiError ? err.message : '审核员令牌无效');
    }
  };

  useEffect(() => {
    void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (c: CardSummary, decision: 'approved' | 'rejected') => {
    const reason = decision === 'rejected' ? prompt('驳回理由（可选）') || undefined : undefined;
    setBusy(c.id);
    try {
      await annotationApi.modDecide(token, c.id, decision, reason);
      setQueue((q) => q.filter((x) => x.id !== c.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="container mx-auto px-6 pt-32 pb-20 max-w-4xl">
      <Link to="/" className="inline-flex items-center gap-2 font-mono text-sm text-white/50 hover:text-teal-300 mb-6">
        <ArrowLeft className="w-4 h-4" /> 返回首页
      </Link>
      <h1 className="font-display text-4xl font-bold text-white mb-2">审核台</h1>
      <p className="text-white/50 text-sm mb-6">
        公开走廊只展示 approved 卡片。审核决定和隐藏操作同样以追加事件 + 版本号记录。
      </p>

      <div className="flex items-center gap-2 mb-8">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="审核员令牌（默认 moderator，可用 MOD_TOKEN 环境变量改）"
          className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-teal-300/50"
        />
        <button
          onClick={() => void load(token)}
          className="px-4 py-2 rounded-lg bg-teal-400/20 border border-teal-300/40 text-teal-100 text-sm"
        >
          登录
        </button>
      </div>
      {error && <div className="text-red-300 text-sm mb-4">{error}</div>}

      {authed && (
        <>
          <div className="text-white/40 text-xs mb-3">待审核（{queue.length}）</div>
          {queue.length === 0 && <div className="glass-card p-10 text-center text-white/40">队列为空 🎉</div>}
          <div className="space-y-4">
            {queue.map((c) => (
              <div key={c.id} className="glass-card p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-display text-lg text-white">{c.title}</h3>
                    <p className="text-white/40 text-xs">
                      {c.authorName} · 标本 #{c.specimenId} · {c.opCount} 条批注 · v{c.version}
                    </p>
                    <p className="text-white/75 text-sm mt-2 whitespace-pre-line">{c.note}</p>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0">
                    <button
                      disabled={busy === c.id}
                      onClick={() => void decide(c, 'approved')}
                      className="px-3 py-1.5 rounded-lg text-xs bg-emerald-400/15 border border-emerald-300/40 text-emerald-200 flex items-center gap-1.5"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" /> 通过挂进走廊
                    </button>
                    <button
                      disabled={busy === c.id}
                      onClick={() => void decide(c, 'rejected')}
                      className="px-3 py-1.5 rounded-lg text-xs bg-red-400/10 border border-red-300/30 text-red-300 flex items-center gap-1.5"
                    >
                      <ShieldX className="w-3.5 h-3.5" /> 驳回
                    </button>
                    <Link
                      to={`/cards/${c.id}`}
                      className="px-3 py-1.5 rounded-lg text-xs border border-white/10 text-white/50 flex items-center gap-1.5 justify-center"
                    >
                      <EyeOff className="w-3.5 h-3.5" /> 预览（作者视角）
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
