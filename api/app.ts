import express from 'express';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import apiRoutes from './routes/index.js';
import { loadStore } from './src/services/annotationStore.js';

await loadStore();

const app = express();

app.use(cors());

// 需要自己读原始流的端点（gzip 请求体 + 压缩炸弹防护），跳过 express.json
const RAW_BODY_ROUTES = [
  /^\/api\/cards\/?$/, // POST /api/cards
  /^\/api\/cards\/[^/]+\/commits\/?$/, // POST /api/cards/:id/commits
  /^\/api\/moderation\/cards\/[^/]+\/?$/, // POST /api/moderation/cards/:id
];
const jsonParser = express.json({ limit: '256kb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && RAW_BODY_ROUTES.some((re) => re.test(req.path))) {
    // 该路径由 AnnotationController.readAnnotationBody 自行消费请求流
    return next();
  }
  jsonParser(req, res, next);
});

app.get('/', (_req, res) => {
  res.json({
    name: '微生物文明馆 API',
    version: '2.0.0',
    endpoints: {
      'GET /api/microbes': '获取所有微生物列表',
      'GET /api/microbes/:id': '获取单个微生物详情',
      'GET /api/cards?specimenId=': '公共走廊：某标本下已过审讲解卡片',
      'POST /api/cards': '创建讲解卡片（矢量笔迹）',
      'POST /api/cards/:id/commits': '追加批注（追加式合并 + 版本号）',
      'POST /api/cards/:id/like': '点赞（服务端去重）',
      'POST /api/cards/:id/fork': '复刻别人的标注继续画',
      'GET  /api/moderation/queue': '待审队列（X-Mod-Token）',
    },
  });
});

app.use('/api', apiRoutes);

// 统一错误处理（ValidationError 携带 status / code）；Express 要求错误中间件必须是 4 个参数
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = err as { status?: number; code?: string; message?: string; type?: string };
  if (e?.type === 'entity.too.large' || e?.type === 'entity.parse.failed') {
    return res.status(413).json({ success: false, error: '请求体超限或格式错误', code: 'BODY_BAD' });
  }
  const status = e?.status ?? 500;
  if (status >= 500) console.error('[api error]', err);
  res.status(status).json({
    success: false,
    error: e?.message ?? '服务器内部错误',
    code: e?.code ?? 'INTERNAL',
  });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: '接口不存在' });
});

export default app;
