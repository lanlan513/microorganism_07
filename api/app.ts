import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import apiRoutes from './routes/index.js';
import { AnnotationStore } from './src/annotation/store.js';
import { createAnnotationRouter } from './src/annotation/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(compression()); // 超大笔迹传输时走 gzip
// 全局兜底：任何请求体超过 256KB 直接 413（超大笔迹数据的体积上限）
app.use(express.json({ limit: '256kb' }));

// 涂鸦共享馆：JSON 文件库（可用 GRAFFITI_DB 环境变量指定路径，便于测试）
const dbPath = process.env.GRAFFITI_DB
  ? resolve(process.env.GRAFFITI_DB)
  : resolve(__dirname, '../data/graffiti.json');
export const annotationStore = new AnnotationStore(dbPath);

app.get('/', (_req, res) => {
  res.json({
    name: '微生物文明馆 API',
    version: '1.1.0',
    endpoints: {
      'GET /api/microbes': '获取所有微生物列表',
      'GET /api/microbes/:id': '获取单个微生物详情',
      'GET /api/microbes/category/:category': '按分类获取微生物',
      'GET /api/microbes/:id/related': '获取相关微生物',
      'GET /api/stats': '获取统计数据',
      'GET /api/annotations/cards': '公共走廊：讲解卡片列表（默认仅 approved）',
      'POST /api/annotations/cards': '创建讲解卡片（矢量笔迹/批注）',
      'GET /api/annotations/cards/:id': '卡片详情（含存活笔迹）',
      'POST /api/annotations/cards/:id/append': '追加批注（baseVersion 乐观并发）',
      'GET /api/annotations/cards/:id/delta': '增量同步 since=version',
      'POST /api/annotations/cards/:id/like': '点赞（服务端按用户去重）',
      'POST /api/annotations/cards/:id/fork': '复刻到自己的标本页',
      'POST /api/annotations/cards/:id/withdraw-op': '撤回自己的某条标注',
      'DELETE /api/annotations/cards/:id': '撤回整张卡片',
      'POST /api/moderation/cards/:id': '审核通过/驳回（审核员密钥）',
    },
  });
});

// 一张路由表里同时包含 /cards* 与 /moderation*，挂在 /api/annotations 下即可
app.use('/api/annotations', createAnnotationRouter(annotationStore));
app.use('/api', apiRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // body-parser 超限等错误统一成 JSON
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.too.large' || e?.status === 413) {
    res.status(413).json({ success: false, error: '请求体超过 256KB 体积上限' });
    return;
  }
  res.status(500).json({ success: false, error: e?.message ?? '服务器内部错误' });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: '接口不存在' });
});

export default app;
