import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Cloud, CloudOff, PenTool, Type, Undo2, Redo2, Send, Copy, RefreshCw } from 'lucide-react';
import { AnnotationCanvas, type AnnotationCanvasHandle, type Tool } from '../components/AnnotationCanvas';
import { annotationApi, ApiError } from '../utils/annotationApi';
import { useAppStore } from '../store/useAppStore';
import type { AnnotationOp, CardStatus } from '../../shared/annotations';
import { applyEvents, emptyState } from '../utils/annotationGeometry';
import { saveDraft, loadDraft, clearDraft, type Draft } from '../utils/drafts';

type SyncState = 'synced' | 'pending' | 'offline' | 'syncing' | 'error';

const COLORS = ['#00ffc8', '#ffd166', '#ff5c5c', '#7aa2ff', '#ffffff'];
const WIDTHS = [0.004, 0.007, 0.012];

export function StudioPage() {
  const { specimenId: sidParam, cardId: cardIdParam } = useParams();
  const specimenId = Number(sidParam);
  const editingCardId = cardIdParam ?? null;
  const navigate = useNavigate();

  const { microbe, fetchMicrobeById } = useAppStore();
  useEffect(() => {
    if (Number.isInteger(specimenId)) void fetchMicrobeById(specimenId);
  }, [specimenId, fetchMicrobeById]);

  const canvasHandle = useRef<AnnotationCanvasHandle>(null);

  // 服务端状态（含别人笔迹）
  const [serverState, setServerState] = useState(() => emptyState(0));
  const [cardInfo, setCardInfo] = useState<{
    cardId: string;
    status: CardStatus;
    title: string;
    note: string;
    forkedFrom: string | null;
  } | null>(editingCardId ? { cardId: editingCardId, status: 'draft', title: '', note: '', forkedFrom: null } : null);

  // 本地未提交笔迹
  const [pendingOps, setPendingOps] = useState<AnnotationOp[]>([]);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [baseWidth, setBaseWidth] = useState(WIDTHS[1]);
  const [syncState, setSyncState] = useState<SyncState>('synced');
  const [message, setMessage] = useState<string>('');
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);

  const syncingRef = useRef(false);
  const serverRef = useRef(serverState);
  serverRef.current = serverState;
  const cardRef = useRef(cardInfo);
  cardRef.current = cardInfo;
  const pendingRef = useRef(pendingOps);
  pendingRef.current = pendingOps;
  // title/note 也走 ref：网络恢复事件在挂载时订阅，闭包不能拿到陈旧的空标题
  const titleRef = useRef(title);
  titleRef.current = title;
  const noteRef = useRef(note);
  noteRef.current = note;

  /* --------------------------- 初始化：服务端 + 本地草稿 --------------------------- */
  useEffect(() => {
    let cancelled = false;
    const draft = loadDraft(specimenId, editingCardId);

    async function init() {
      if (editingCardId) {
        try {
          const detail = await annotationApi.getCard(editingCardId);
          if (cancelled) return;
          let st = emptyState(0);
          st = applyEvents(st, detail.events);
          setServerState(st);
          setCardInfo({
            cardId: detail.card.id,
            status: detail.status,
            title: detail.card.title,
            note: detail.note,
            forkedFrom: detail.forkedFrom,
          });
          setTitle(draft?.title ?? detail.card.title);
          setNote(draft?.note ?? detail.note);
          if (draft?.pendingOps?.length) {
            setPendingOps(draft.pendingOps);
            setSyncState(navigator.onLine ? 'pending' : 'offline');
          }
        } catch (err) {
          setMessage(`加载卡片失败：${(err as Error).message}`);
        }
      } else if (draft) {
        // 离线/未创建的新卡片草稿恢复
        setTitle(draft.title);
        setNote(draft.note);
        if (draft.serverOps.length) {
          let st = emptyState(draft.baseVersion);
          st = { ...st, serverOps: draft.serverOps };
          setServerState(st);
        }
        if (draft.pendingOps.length) setPendingOps(draft.pendingOps);
        setSyncState(navigator.onLine ? 'pending' : 'offline');
        setMessage('已恢复本地未提交草稿');
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [editingCardId, specimenId]);

  /* ------------------------------- 草稿落盘（防抖） ------------------------------- */
  useEffect(() => {
    const t = setTimeout(() => {
      const draft: Draft = {
        cardId: cardInfo?.cardId ?? null,
        specimenId,
        title,
        note,
        forkedFrom: cardInfo?.forkedFrom ?? null,
        baseVersion: serverState.version,
        serverOps: serverState.serverOps,
        pendingOps,
        updatedAt: Date.now(),
      };
      saveDraft(draft);
    }, 800);
    return () => clearTimeout(t);
  }, [title, note, pendingOps, serverState, cardInfo, specimenId]);

  /* ------------------------------- 在线/离线事件 ------------------------------- */
  useEffect(() => {
    const on = () => {
      setOnline(true);
      setMessage('网络恢复，正在与服务器合并…');
      void pullAndPush();
    };
    const off = () => {
      setOnline(false);
      setSyncState('offline');
      setMessage('已离线：笔迹暂存本地，恢复后自动与服务器版本合并');
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------- 增量拉取别人笔迹（轮询 6s） ------------------------- */
  const pull = useCallback(async (): Promise<boolean> => {
    const cid = cardRef.current?.cardId;
    if (!cid) return false;
    try {
      const detail = await annotationApi.getCard(cid, serverRef.current.version);
      if (detail.events.length) {
        // 合并（去重/撤回标记），不动本地 pendingOps
        setServerState((prev) => applyEvents(prev, detail.events));
        setCardInfo((prev) =>
          prev ? { ...prev, status: detail.status, title: detail.card.title, note: detail.note } : prev,
        );
        return true;
      }
      // 状态可能变化（如被审核通过），即使没有新事件
      setCardInfo((prev) => (prev && prev.status !== detail.status ? { ...prev, status: detail.status } : prev));
      return false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setCardInfo((prev) => (prev ? { ...prev, status: 'retracted' } : prev));
      }
      return false;
    }
  }, []);

  useEffect(() => {
    if (!cardInfo?.cardId) return;
    const timer = setInterval(() => void pull(), 6000);
    return () => clearInterval(timer);
  }, [cardInfo?.cardId, pull]);

  /* --------------------------- 核心同步：先合并再提交 --------------------------- */
  const pullAndPush = useCallback(async (): Promise<void> => {
    if (syncingRef.current) return;
    if (!navigator.onLine) {
      setSyncState('offline');
      return;
    }
    syncingRef.current = true;
    setSyncState('syncing');
    try {
      let cid = cardRef.current?.cardId ?? null;

      // 1) 新卡片：创建（自带当前 pending）
      if (!cid) {
        if (!titleRef.current.trim() || !noteRef.current.trim()) {
          setSyncState(pendingRef.current.length ? 'pending' : 'synced');
          setMessage('先填写标题和两句讲解，才能同步卡片');
          return;
        }
        const created = await annotationApi.createCard({
          specimenId,
          title: titleRef.current.trim(),
          note: noteRef.current.trim(),
          ops: pendingRef.current,
        });
        cid = created.card.id;
        setCardInfo({
          cardId: cid,
          status: created.card.status,
          title: created.card.title,
          note: created.card.note,
          forkedFrom: null,
        });
        let st = emptyState(0);
        st = applyEvents(st, created.commit.events);
        setServerState(st);
        setPendingOps([]);
        clearDraft(specimenId, null);
        setSyncState('synced');
        setMessage('卡片已保存为草稿');
        // URL 带上 cardId，刷新也能恢复
        window.history.replaceState(null, '', `/studio/${specimenId}/${cid}`);
        return;
      }

      // 2) 已有卡片：先拉别人新增的笔迹（增量 since=本地版本），合并进来
      await pull();

      // 3) 再以「服务器最新版本号」为 base 提交自己的笔迹。
      //    即便此刻又落后了，服务端也会 fast-forward 追加并返回对方那批事件 → 互不覆盖。
      const myOps = pendingRef.current;
      if (myOps.length) {
        const result = await annotationApi.commit(cid, serverRef.current.version, myOps);
        // result.events 同时含「并发对方的笔迹」和「自己这批笔迹」，统一按事件合并
        setServerState((prev) => applyEvents(prev, result.events));
        const done = new Set([...result.accepted, ...result.duplicates]);
        setPendingOps((cur) => cur.filter((op) => !done.has(op.id)));
        if (result.duplicates.length) {
          setMessage(`合并完成：新写入 ${result.accepted.length} 条，重试幂等跳过 ${result.duplicates.length} 条`);
        } else if (result.accepted.length) {
          setMessage(`已追加 ${result.accepted.length} 条笔迹，当前版本 v${result.version}`);
        }
      }
      setSyncState('synced');
    } catch (err) {
      const networkDown =
        !navigator.onLine ||
        (err instanceof TypeError && /fetch|network|Failed to fetch/i.test(err.message));
      if (networkDown) {
        setSyncState('offline');
        setMessage('网络不可用：笔迹已保存在本地草稿，恢复后先拉增量再合并提交');
      } else {
        setSyncState('error');
        setMessage(`同步失败：${(err as Error).message}（本地笔迹未丢，可重试）`);
      }
    } finally {
      syncingRef.current = false;
      setBusy(false);
    }
  }, [pull, specimenId]);

  // 本地有新笔迹时自动同步（防抖 1.2s）
  useEffect(() => {
    if (!pendingOps.length) return;
    setSyncState(online ? 'pending' : 'offline');
    const t = setTimeout(() => void pullAndPush(), 1200);
    return () => clearTimeout(t);
  }, [pendingOps, online, pullAndPush]);

  /* --------------------------------- 发布 --------------------------------- */
  const publish = async () => {
    setBusy(true);
    try {
      if (pendingOps.length || !cardInfo?.cardId) await pullAndPush();
      const cid = cardRef.current?.cardId;
      if (!cid) throw new Error('请先等待笔迹同步');
      await annotationApi.publish(cid);
      setCardInfo((p) => (p ? { ...p, status: 'pending' } : p));
      setMessage('已提交审核，通过后会挂进公共走廊');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------------- UI --------------------------------- */
  const committed = useMemo(() => serverState.serverOps, [serverState]);
  const metaMap = serverState.serverOpMeta;

  const statusBadge: Record<CardStatus, { text: string; cls: string }> = {
    draft: { text: '草稿（仅自己可见）', cls: 'bg-white/10 text-white/70' },
    pending: { text: '待审核', cls: 'bg-amber-500/20 text-amber-300' },
    approved: { text: '已通过 · 公共走廊', cls: 'bg-emerald-500/20 text-emerald-300' },
    rejected: { text: '审核未通过（可修改后重新发布）', cls: 'bg-red-500/20 text-red-300' },
    retracted: { text: '已撤回', cls: 'bg-white/10 text-white/50' },
  };

  if (!microbe) {
    return <div className="container mx-auto px-6 pt-32 text-white/60">加载标本…</div>;
  }

  const syncIcon = {
    synced: <Cloud className="w-4 h-4 text-emerald-400" />,
    pending: <Cloud className="w-4 h-4 text-amber-300 animate-pulse" />,
    syncing: <RefreshCw className="w-4 h-4 text-sky-300 animate-spin" />,
    offline: <CloudOff className="w-4 h-4 text-red-300" />,
    error: <CloudOff className="w-4 h-4 text-red-400" />,
  }[syncState];

  return (
    <div className="container mx-auto px-4 md:px-6 pt-28 pb-20 max-w-7xl">
      <Link
        to={`/microbe/${specimenId}`}
        className="inline-flex items-center gap-2 font-mono text-sm text-white/50 hover:text-teal-300 mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> 返回标本页
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display text-3xl md:text-4xl font-bold text-white">讲解卡片工作室</h1>
          <p className="text-white/50 text-sm mt-1">
            在「{microbe.name}」的同一视野上圈鞭毛、标分裂细胞、写讲解 · v{serverState.version} ·{' '}
            {serverState.serverOps.length + pendingOps.length} 条笔迹
          </p>
        </div>
        {cardInfo && (
          <span className={`text-xs px-3 py-1.5 rounded-full ${statusBadge[cardInfo.status].cls}`}>
            {statusBadge[cardInfo.status].text}
          </span>
        )}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-6">
        {/* 左：画布 + 工具栏 */}
        <div>
          <div className="glass-card p-3 md:p-4">
            <AnnotationCanvas
              ref={canvasHandle}
              backgroundUrl={microbe.imageUrl}
              committedOps={committed}
              pendingOps={pendingOps}
              meta={metaMap}
              color={color}
              baseWidth={baseWidth}
              tool={tool}
              readOnly={cardInfo?.status === 'retracted'}
              onChange={(ops) => setPendingOps(ops)}
            />
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                className={`px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 border ${
                  tool === 'pen' ? 'bg-teal-400/20 border-teal-300/50 text-teal-200' : 'border-white/10 text-white/60'
                }`}
                onClick={() => setTool('pen')}
              >
                <PenTool className="w-4 h-4" /> 笔（压感/速度笔锋）
              </button>
              <button
                className={`px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 border ${
                  tool === 'text' ? 'bg-teal-400/20 border-teal-300/50 text-teal-200' : 'border-white/10 text-white/60'
                }`}
                onClick={() => setTool('text')}
              >
                <Type className="w-4 h-4" /> 文字
              </button>
              <div className="w-px h-6 bg-white/10 mx-1" />
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className="w-7 h-7 rounded-full border-2"
                  style={{ background: c, borderColor: color === c ? '#fff' : 'transparent' }}
                  aria-label={`颜色 ${c}`}
                />
              ))}
              <div className="w-px h-6 bg-white/10 mx-1" />
              {WIDTHS.map((w) => (
                <button
                  key={w}
                  onClick={() => setBaseWidth(w)}
                  className={`w-8 h-8 rounded-lg border flex items-center justify-center ${
                    baseWidth === w ? 'border-teal-300/60' : 'border-white/10'
                  }`}
                  aria-label={`笔宽 ${w}`}
                >
                  <span className="rounded-full bg-white" style={{ width: 10 + w * 1200, height: 10 + w * 1200 }} />
                </button>
              ))}
              <div className="w-px h-6 bg-white/10 mx-1" />
              <button
                className="px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 border border-white/10 text-white/60 hover:text-white disabled:opacity-30"
                onClick={() => canvasHandle.current?.undo()}
                disabled={!pendingOps.length}
                title="撤销（支持 ≥20 步）"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                className="px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 border border-white/10 text-white/60 hover:text-white"
                onClick={() => canvasHandle.current?.redo()}
                title="重做"
              >
                <Redo2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 别人的笔迹署名（同一视野追加） */}
          {committed.length > 0 && (
            <div className="glass-card mt-4 p-4">
              <div className="text-xs text-white/40 tracking-widest mb-2">同一视野上的笔迹（按版本追加）</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {[...new Map(committed.map((op) => {
                  const m = metaMap.get(op.id);
                  return [m?.authorName ?? '佚名', m?.authorName ?? '佚名'];
                })).values()].map((name) => (
                  <span key={name} className="px-2 py-1 rounded-full bg-white/5 border border-white/10 text-white/70">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 右：讲解 + 同步 */}
        <div className="space-y-4">
          <div className="glass-card p-5">
            <label className="text-xs text-white/40 tracking-widest">卡片标题</label>
            <input
              value={title}
              maxLength={60}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：大肠杆菌的鞭毛与二分裂"
              className="w-full mt-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-teal-300/50"
            />
            <label className="text-xs text-white/40 tracking-widest mt-4 block">两句讲解（≤300 字）</label>
            <textarea
              value={note}
              maxLength={300}
              rows={5}
              onChange={(e) => setNote(e.target.value)}
              placeholder={'第一句：红色圈出的是周生鞭毛，负责游动。\n第二句：黄色箭头处正在二分裂，细胞中部内陷。'}
              className="w-full mt-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white/90 text-sm leading-6 outline-none focus:border-teal-300/50 resize-none"
            />
            <div className="text-right text-[10px] text-white/30">{note.length}/300</div>
          </div>

          <div className="glass-card p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm text-white/70">
              {syncIcon}
              <span>
                {syncState === 'synced' && `已同步 · 服务器版本 v${serverState.version}`}
                {syncState === 'pending' && `待同步 ${pendingOps.length} 条笔迹…`}
                {syncState === 'syncing' && '合并同步中…'}
                {syncState === 'offline' && '离线 · 草稿在本地'}
                {syncState === 'error' && '同步出错'}
              </span>
            </div>
            {message && <p className="text-xs text-amber-200/80 leading-5">{message}</p>}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={() => void pullAndPush()}
                disabled={syncState === 'syncing'}
                className="px-3 py-2.5 rounded-lg text-sm border border-white/15 text-white/80 flex items-center justify-center gap-1.5 hover:bg-white/5 disabled:opacity-40"
              >
                <RefreshCw className={`w-4 h-4 ${syncState === 'syncing' ? 'animate-spin' : ''}`} /> 立即同步
              </button>
              <button
                onClick={() => void publish()}
                disabled={!['draft', 'rejected'].includes(cardInfo?.status ?? 'draft') || busy}
                className="px-3 py-2.5 rounded-lg text-sm bg-teal-400/20 border border-teal-300/40 text-teal-100 flex items-center justify-center gap-1.5 hover:bg-teal-400/30 disabled:opacity-30"
              >
                <Send className="w-4 h-4" /> 发布送审
              </button>
            </div>
            {cardInfo?.forkedFrom && (
              <div className="text-[11px] text-white/40 flex items-center gap-1 pt-1">
                <Copy className="w-3 h-3" /> 复刻自卡片 …{cardInfo.forkedFrom.slice(-6)}，原笔迹作者署名保留
              </div>
            )}
            <div className="text-[10px] text-white/30 leading-5 pt-1 border-t border-white/5">
              笔迹以矢量坐标存服务端（非截图）；并发追加按版本号 fast-forward 合并，双方都能看到对方笔迹；
              断网时只写本地，恢复后先拉增量再提交。
            </div>
            {cardInfo?.cardId && (
              <button
                onClick={() => navigate(`/cards/${cardInfo.cardId}`)}
                className="w-full text-xs text-teal-300/80 hover:text-teal-200 pt-1"
              >
                查看这张卡片的公共页 →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
