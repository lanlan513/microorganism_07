import { Router } from 'express';
import { MicrobeController } from '../src/controllers/MicrobeController.js';
import { AnnotationController as A } from '../src/controllers/AnnotationController.js';

const router = Router();

router.get('/microbes', MicrobeController.getAll);
router.get('/microbes/stats', MicrobeController.getStats);
router.get('/microbes/category/:category', MicrobeController.getByCategory);
router.get('/microbes/:id', MicrobeController.getById);
router.get('/microbes/:id/related', MicrobeController.getRelated);
router.get('/stats', MicrobeController.getStats);

/* ------------------------------ 讲解卡片（矢量批注馆） ------------------------------ */

// 公共走廊 / 我的卡片
router.get('/cards', A.list);
router.post('/cards', A.create);
router.get('/cards/:id', A.get);
// 追加批注：追加式合并 + 版本号
router.post('/cards/:id/commits', A.commit);
// 复刻到自己的标本页继续画
router.post('/cards/:id/fork', A.fork);
// 点赞（服务端去重）
router.post('/cards/:id/like', A.like);
// 发布 / 撤回自己发布的标注
router.post('/cards/:id/:action(publish|retract)', A.lifecycle);
// 撤回自己的单条批注
router.post('/cards/:id/ops/:opId/retract', A.retractOp);

// 审核侧
router.get('/moderation/queue', A.modQueue);
router.post('/moderation/cards/:id', A.modDecide);
router.post('/moderation/cards/:id/ops/:opId/hide', A.modHideOp);

export default router;
