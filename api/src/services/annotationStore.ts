import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnnotationCard, CardStatus } from '../../../shared/annotations.js';

export interface PersistedState {
  cards: Record<string, AnnotationCard>;
  /** cardId -> 去重后的点赞用户集合（服务端去重的唯一事实来源） */
  likes: Record<string, string[]>;
}

const DB_PATH =
  process.env.ANNOTATION_DB || path.join(process.cwd(), 'api', 'src', 'data', 'annotationStore.json');

let state: PersistedState = { cards: {}, likes: {} };
let saveTimer: NodeJS.Timeout | null = null;
let saving: Promise<void> | null = null;

export async function loadStore(): Promise<void> {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    state = { cards: parsed.cards ?? {}, likes: parsed.likes ?? {} };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    state = { cards: {}, likes: {} };
  }
}

/** 防抖落盘：高频合并提交不会触发海量 IO；进程退出前 flushStore 兜底 */
export function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving = doSave();
  }, 400);
  saveTimer.unref?.();
}

async function doSave(): Promise<void> {
  const tmp = DB_PATH + '.tmp';
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fs.rename(tmp, DB_PATH);
}

export async function flushStore(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saving;
  await doSave();
}

export const db = {
  get cards(): Record<string, AnnotationCard> {
    return state.cards;
  },
  likesFor(cardId: string): Set<string> {
    return new Set(state.likes[cardId] ?? []);
  },
  setLikes(cardId: string, users: Set<string>): void {
    if (users.size === 0) delete state.likes[cardId];
    else state.likes[cardId] = [...users];
    scheduleSave();
  },
};

export function countLikes(cardId: string): number {
  return (state.likes[cardId] ?? []).length;
}

export function listCards(filter: {
  specimenId?: number;
  status?: CardStatus | CardStatus[];
  authorId?: string;
}): AnnotationCard[] {
  let list = Object.values(state.cards);
  if (filter.specimenId !== undefined) list = list.filter((c) => c.specimenId === filter.specimenId);
  if (filter.authorId !== undefined) list = list.filter((c) => c.authorId === filter.authorId);
  if (filter.status) {
    const set = new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
    list = list.filter((c) => set.has(c.status));
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}
