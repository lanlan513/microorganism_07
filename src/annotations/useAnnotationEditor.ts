import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LIMITS,
  uuid,
  type AppendOp,
  type LogEntry,
  type Note,
  type Stroke,
} from '../../shared/annotation';
import { annotationApi, getIdentity } from './api';
import {
  draftLiveOps,
  draftStore,
  refreshDraftFromServer,
  syncDraft,
  type DraftRecord,
} from './offline';

/**
 * 标注编辑器状态：
 *  - localOps 是本次会话内"本地产生且尚未被撤销掉"的操作（含已发布和未发布的）
 *  - undoStack/redoStack 以"一条完整笔迹/一个批注"为单位，至少 20 步，上限 100
 */
export interface EditorState {
  loading: boolean;
  publishing: boolean;
  online: boolean;
  draft: DraftRecord | null;
  liveOps: LogEntry[]; // 渲染用：服务端笔迹 + 未同步的本地尾巴
  localOps: AppendOp[];
  canUndo: boolean;
  canRedo: boolean;
  syncState: 'idle' | 'syncing' | 'offline-queued' | 'error';
  syncMessage: string;
  conflictsResolved: number;
}

function newDraft(specimenId: number, forkedFrom?: string): DraftRecord {
  return {
    key: `local:${uuid()}`,
    cardId: null,
    specimenId,
    title: '',
    authorId: getIdentity().userId,
    ops: [],
    pendingOpIds: [],
    confirmedOpIds: [],
    tombstoneOpIds: [],
    serverVersion: 0,
    serverOps: [],
    updatedAt: Date.now(),
    forkedFrom: forkedFrom ?? null,
  };
}

export function useAnnotationEditor(opts: { specimenId: number; cardId?: string | null }) {
  const [state, setState] = useState<EditorState>(() => ({
    loading: true,
    publishing: false,
    online: navigator.onLine,
    draft: null,
    liveOps: [],
    localOps: [],
    canUndo: false,
    canRedo: false,
    syncState: 'idle',
    syncMessage: '',
    conflictsResolved: 0,
  }));

  const draftRef = useRef<DraftRecord | null>(null);
  const undoStack = useRef<AppendOp[][]>([]);
  const redoStack = useRef<AppendOp[][]>([]);
  const localOpsRef = useRef<AppendOp[]>([]);
  const saveTimer = useRef<number | null>(null);
  // autoSync 定义在操作回调之后（它本身又依赖 recompute），用 ref 打破循环引用
  const autoSyncRef = useRef<() => Promise<void>>(async () => {});

  const recompute = useCallback((patch: Partial<EditorState> = {}) => {
    const draft = draftRef.current;
    if (!draft) return;
    const local = localOpsRef.current;
    setState((s) => ({
      ...s,
      draft,
      localOps: local,
      liveOps: draftLiveOps({ ...draft, ops: local }),
      canUndo: undoStack.current.length > 0,
      canRedo: redoStack.current.length > 0,
      ...patch,
    }));
  }, []);

  /** 防抖持久化草稿（离线时也存） */
  const persistSoon = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const d = draftRef.current;
      if (d) void draftStore.put({ ...d, ops: localOpsRef.current, updatedAt: Date.now() });
    }, 300);
  }, []);

  // ---------- 初始化：已有卡片 -> 拉服务端 + 合并本地草稿；新卡 -> 新建/恢复草稿 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let draft: DraftRecord;
      const stored = opts.cardId ? await draftStore.get(opts.cardId) : undefined;
      if (opts.cardId) {
        if (stored) {
          draft = { tombstoneOpIds: [], ...stored }; // 兼容旧格式草稿
        } else {
          const d = await annotationApi.getCard(opts.cardId!);
          draft = {
            key: opts.cardId,
            cardId: d.data.id,
            specimenId: d.data.specimenId,
            title: d.data.title,
            authorId: d.data.authorId,
            ops: [],
            pendingOpIds: [],
            confirmedOpIds: d.data.liveOps.map((o) => o.opId),
            tombstoneOpIds: [],
            serverVersion: d.data.version,
            serverOps: d.data.liveOps,
            updatedAt: Date.now(),
          };
        }
        if (navigator.onLine) {
          try {
            draft = await refreshDraftFromServer(draft);
          } catch {
            /* 离线恢复时保留本地快照 */
          }
        }
        // 以服务端卡片上的 specimenId 为准
        opts.specimenId = draft.specimenId;
        localOpsRef.current = draft.ops.filter((o) => draft.pendingOpIds.includes(o.opId) || !draft.cardId);
      } else {
        // 新卡：恢复最近一张同标本、未发布的本地草稿（离线场景）
        const all = await draftStore.list();
        const reopen = all
          .filter((d) => !d.cardId && d.specimenId === opts.specimenId)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        draft = reopen ?? newDraft(opts.specimenId);
        localOpsRef.current = draft.ops;
      }
      if (cancelled) return;
      draftRef.current = draft;
      await draftStore.put({ ...draft, ops: localOpsRef.current });
      setState((s) => ({ ...s, loading: false }));
      recompute({
        syncState: navigator.onLine ? 'idle' : 'offline-queued',
        syncMessage: navigator.onLine ? '' : '当前离线，笔迹已存入本地草稿',
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.cardId, opts.specimenId]);

  const makeOp = useCallback((payload: AppendOp['payload']): AppendOp => {
    const id = getIdentity();
    return { opId: uuid(), authorId: id.userId, authorName: id.userName, createdAt: Date.now(), payload };
  }, []);

  /** 收一条新笔画（引擎回调） */
  const addStroke = useCallback(
    (stroke: Stroke) => {
      const op = makeOp({ kind: 'stroke', stroke });
      localOpsRef.current = [...localOpsRef.current, op];
      undoStack.current.push([op]);
      if (undoStack.current.length > LIMITS.UNDO_REDO_CAP) undoStack.current.shift();
      redoStack.current = [];
      persistSoon();
      void autoSyncRef.current();
      recompute();
    },
    [makeOp, persistSoon, recompute],
  );

  const addNote = useCallback(
    (note: Note) => {
      const op = makeOp({ kind: 'note', note });
      localOpsRef.current = [...localOpsRef.current, op];
      undoStack.current.push([op]);
      if (undoStack.current.length > LIMITS.UNDO_REDO_CAP) undoStack.current.shift();
      redoStack.current = [];
      persistSoon();
      void autoSyncRef.current();
      recompute();
    },
    [makeOp, persistSoon, recompute],
  );

  const undo = useCallback(() => {
    const batch = undoStack.current.pop();
    if (!batch) return;
    const ids = new Set(batch.map((o) => o.opId));
    localOpsRef.current = localOpsRef.current.filter((o) => !ids.has(o.opId));
    redoStack.current.push(batch);
    // 已发布（服务端已有）的笔迹被 undo：登记墓碑，下次同步时撤回
    const draft = draftRef.current;
    if (draft) {
      const onServer = new Set(draft.serverOps.map((o) => o.opId));
      const confirmed = new Set(draft.confirmedOpIds);
      const toTomb = batch
        .map((o) => o.opId)
        .filter((id) => onServer.has(id) || confirmed.has(id));
      if (toTomb.length) {
        draft.tombstoneOpIds = [...new Set([...draft.tombstoneOpIds, ...toTomb])];
      }
    }
    persistSoon();
    void autoSyncRef.current();
    recompute();
  }, [persistSoon, recompute]);

  const redo = useCallback(() => {
    const batch = redoStack.current.pop();
    if (!batch) return;
    localOpsRef.current = [...localOpsRef.current, ...batch];
    undoStack.current.push(batch);
    // 若墓碑还没同步成功，撤销撤回；已同步的墓碑无法 redo（服务端只追加）
    const draft = draftRef.current;
    if (draft) {
      const ids = new Set(batch.map((o) => o.opId));
      draft.tombstoneOpIds = draft.tombstoneOpIds.filter((id) => !ids.has(id));
    }
    persistSoon();
    void autoSyncRef.current();
    recompute();
  }, [persistSoon, recompute]);

  const setTitle = useCallback(
    (title: string) => {
      if (draftRef.current) {
        draftRef.current.title = title.slice(0, LIMITS.MAX_TITLE_CHARS);
        persistSoon();
      }
    },
    [persistSoon],
  );

  /** 同步：新卡 -> create；已发布 -> append pending。离线则排队 */
  const autoSync = useCallback(async (): Promise<void> => {
    const draft = draftRef.current;
    if (!draft) return;
    draft.ops = localOpsRef.current;
    draft.pendingOpIds = draft.cardId
      ? localOpsRef.current
          .filter((o) => !draft.confirmedOpIds.includes(o.opId) && !draft.tombstoneOpIds.includes(o.opId))
          .map((o) => o.opId)
      : [];
    await draftStore.put({ ...draft });
    if (!navigator.onLine) {
      recompute({ syncState: 'offline-queued', syncMessage: '离线中：笔迹已保存在本机，恢复网络后自动合并' });
      return;
    }
    if (!draft.cardId) return; // 新卡等用户点发布（先审后发）
    if (draft.pendingOpIds.length === 0 && draft.tombstoneOpIds.length === 0) {
      recompute({ syncState: 'idle', syncMessage: '' });
      return;
    }
    recompute({ syncState: 'syncing', syncMessage: '正在同步…' });
    try {
      const { draft: synced, result } = await syncDraft({ ...draft, ops: localOpsRef.current });
      draftRef.current = { ...synced };
      // 本地尾巴里已被服务端接受的操作不再算作 local
      const accepted = new Set(synced.confirmedOpIds);
      localOpsRef.current = localOpsRef.current.filter((o) => !accepted.has(o.opId));
      recompute({
        syncState: 'idle',
        syncMessage: result.conflictsResolved
          ? `检测到 ${result.conflictsResolved} 次并发，已自动合并对方笔迹`
          : '已同步',
        conflictsResolved: state.conflictsResolved + result.conflictsResolved,
      });
    } catch (e) {
      recompute({ syncState: 'error', syncMessage: e instanceof Error ? e.message : '同步失败，将稍后重试' });
    }
  }, [recompute, state.conflictsResolved]);

  /** 发布新卡；离线时不报错，保留本地草稿，网络恢复后自动发布 */
  const publish = useCallback(async () => {
    const draft = draftRef.current;
    if (!draft) return null;
    if (localOpsRef.current.filter((o) => !draft.tombstoneOpIds.includes(o.opId)).length === 0) {
      recompute({ syncState: 'error', syncMessage: '至少画一笔或写一句讲解再发布' });
      return null;
    }
    if (!navigator.onLine) {
      draft.ops = localOpsRef.current;
      await draftStore.put({ ...draft });
      recompute({ syncState: 'offline-queued', syncMessage: '当前离线：草稿已保存在本机，恢复网络后会自动发布' });
      return null;
    }
    setState((s) => ({ ...s, publishing: true }));
    draft.ops = localOpsRef.current;
    draft.title = draft.title || '未命名讲解';
    try {
      const { draft: synced, result } = await syncDraft({ ...draft });
      draftRef.current = { ...synced };
      localOpsRef.current = [];
      undoStack.current = [];
      redoStack.current = [];
      recompute({
        syncState: 'idle',
        syncMessage: '已提交审核，通过后会出现在公共走廊',
        conflictsResolved: state.conflictsResolved + result.conflictsResolved,
      });
      return synced.cardId;
    } catch (e) {
      recompute({ syncState: 'error', syncMessage: e instanceof Error ? `发布失败（草稿已保留）：${e.message}` : '发布失败（草稿已保留）' });
      return null;
    } finally {
      setState((s) => ({ ...s, publishing: false }));
    }
  }, [recompute, state.conflictsResolved]);

  // ---------- 网络状态：上线即与服务端合并；离线草稿排队 ----------
  useEffect(() => {
    const onOnline = () => {
      setState((s) => ({ ...s, online: true }));
      recompute({ syncState: 'syncing', syncMessage: '网络恢复，正在与服务端合并…' });
      void (async () => {
        const draft = draftRef.current;
        if (!draft) return;
        if (draft.cardId) {
          try {
            draftRef.current = await refreshDraftFromServer({ ...draft });
          } catch {
            /* 保留本地快照 */
          }
        }
        await autoSync();
      })();
    };
    const onOffline = () => {
      setState((s) => ({ ...s, online: false }));
      recompute({ syncState: 'offline-queued', syncMessage: '已离线：笔迹保存在本机，恢复后自动合并' });
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [recompute, autoSync]);

  // ---------- 轮询：已发布卡片打开期间，每 8 秒增量吸收别人的并发笔迹 ----------
  useEffect(() => {
    const id = window.setInterval(() => {
      const draft = draftRef.current;
      if (!draft?.cardId || !navigator.onLine) return;
      void (async () => {
        try {
          const r = await annotationApi.delta(draft.cardId!, draft.serverVersion);
          if (r.data.version === draft.serverVersion) return;
          // 有新版本：拉全量（delta 只含日志片段，归约需完整墓碑集合，简化处理）
          const detail = await annotationApi.getCard(draft.cardId!);
          draftRef.current = { ...draftRef.current!, serverOps: detail.data.liveOps, serverVersion: detail.data.version };
          await draftStore.put(draftRef.current!);
          recompute();
        } catch {
          /* 轮询失败静默，下一轮再试 */
        }
      })();
    }, 8000);
    return () => window.clearInterval(id);
  }, [recompute]);

  // 保持 ref 指向最新的 autoSync（其闭包随渲染刷新）
  useEffect(() => {
    autoSyncRef.current = autoSync;
  });

  return { state, addStroke, addNote, undo, redo, setTitle, publish, resync: autoSync };
}
