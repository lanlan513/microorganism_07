import { create } from 'zustand';
import type { Microbe, MicrobeCategory, Stats } from '../../shared/types';
import { api } from '../utils/api';

interface AppState {
  microbes: Microbe[];
  microbe: Microbe | null;
  related: Microbe[];
  stats: Stats | null;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  activeCategory: MicrobeCategory | null;
  fetchMicrobes: (params?: { category?: MicrobeCategory; search?: string; limit?: number; offset?: number }) => Promise<void>;
  fetchMicrobeById: (id: number) => Promise<void>;
  fetchRelated: (id: number) => Promise<void>;
  fetchStats: () => Promise<void>;
  setSearchQuery: (query: string) => void;
  setActiveCategory: (category: MicrobeCategory | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  microbes: [],
  microbe: null,
  related: [],
  stats: null,
  loading: false,
  error: null,
  searchQuery: '',
  activeCategory: null,

  fetchMicrobes: async (params) => {
    set({ loading: true, error: null });
    try {
      const data = await api.getMicrobes(params);
      set({ microbes: data, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  fetchMicrobeById: async (id) => {
    set({ loading: true, error: null, microbe: null });
    try {
      const data = await api.getMicrobeById(id);
      set({ microbe: data, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  fetchRelated: async (id) => {
    try {
      const data = await api.getRelated(id);
      set({ related: data });
    } catch (err) {
      console.error(err);
    }
  },

  fetchStats: async () => {
    try {
      const data = await api.getStats();
      set({ stats: data });
    } catch (err) {
      console.error(err);
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  setActiveCategory: (category) => set({ activeCategory: category }),
}));
