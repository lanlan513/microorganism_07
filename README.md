# 显微镜视野涂鸦共享馆（讲解卡片）

在微生物图鉴站点上，用户可以在同一张标本图上：圈出鞭毛、标出正在分裂的细胞、写两句讲解，
做成一张「讲解卡片」挂进**公共走廊**；别人能看、点赞、在**同一个视野**上追加批注，
也能把别人的标注**复刻**到自己的标本页继续画。

- 标注以**矢量笔迹**（归一化坐标点序列）存在服务端，不是截图；
- 公开卡片有完整审核状态：`draft → pending → approved / rejected`，作者可 `retracted`；
- 点赞在**服务端去重**（Set 幂等，再点取消）；
- 并发追加采用**只追加事件日志 + 版本号**，冲突时双方都能看到对方笔迹，绝不互相覆盖；
- 前端 Canvas 手写：压感/速度驱动笔锋、二次贝塞尔平滑、撤销重做（栈深 100）、
  触摸与手写笔（Pointer Events）、按设备像素比缩放不发虚；
- 离线草稿存本地，恢复后**先拉增量再提交**，与服务器版本合并而不冲掉别人笔迹。

## 启动

```bash
npm install
npm run dev          # 前端 Vite :5173 + 后端 Express :3001（/api 已配代理）
```

- 标本详情页：`/microbe/1`，底部有「这个视野的讲解卡片」
- 创作工作室：`/studio/:specimenId`（新建）、`/studio/:specimenId/:cardId`（追加）
- 公共走廊：`/corridor`、`/corridor/:specimenId`；卡片页：`/cards/:id`
- 审核台：`/moderation`，审核令牌默认 `moderator`（可用环境变量 `MOD_TOKEN` 覆盖）

运行期数据用文件存储：`api/src/data/annotationStore.json`（防抖落盘，退出前 flush），
可用环境变量 `ANNOTATION_DB` 指定别的路径。

## 数据模型与并发协议（核心）

每张卡片是一条**只追加事件日志**：

```
Card { version, events: CardEvent[] }
CardEvent =
  | { v, kind:'add',        record:{ id, op, authorId, authorName, ts } }
  | { v, kind:'retract-op', opId, by }
  | { v, kind:'hide-op',    opId, by }
  | { v, kind:'status',     status, by, reason? }
```

- 每条新笔迹 = 一个 `add` 事件，服务端分配单调递增的 `v`；
- 提交带 `baseVersion`。服务端**不要求它最新**：新笔迹一律 fast-forward 追加到日志尾部；
- 响应返回 **`baseVersion` 之后的全部事件**——并发落后方在这一个响应里就能看到对方刚写的笔迹；
- `op.id` 由客户端生成，服务端按 id **幂等去重**，失败重试不会产生重复笔迹、不白涨版本；
- 撤回/隐藏也是追加标记事件，笔迹不从日志物理删除，只是对无权限方不可见。

> 实现注意：裁剪响应事件必须用**请求方的 baseVersion**，不能用追加后的 `card.version`，
> 否则落后方会错过对方笔迹。这个缺陷曾被单测抓出并修复（见 `shared/annotations.ts` 的 `mergeCommit`）。

### 可复现：两人同时画，冲突时两边都看到对方

```bash
npm run test:merge    # 纯内核，确定性，直接证明合并语义
npm run test:e2e      # 真实起 HTTP 服务，23 步端到端
```

`e2e` 场景 B 就是「两个人同时画」：两个客户端都只看到 v3，用 `Promise.all` 同时 POST：

```
POST /api/cards/:id/commits  Alice  { baseVersion:3, ops:[alice-1, alice-2] }
POST /api/cards/:id/commits  Bob    { baseVersion:3, ops:[bob-1] }   // 同时发出
```

实际结果（谁先到谁拿 v4，后到者拿 v5；本次运行 Alice 先到）：

```
Alice（先到）响应含笔迹: alice-x-1, alice-x-2
Bob  （后到）响应含笔迹: alice-x-1, alice-x-2, bob-y-1   ← 响应里直接带着 Alice 的笔迹
增量同步后同屏笔迹（since=v3）：alice-x-1, alice-x-2, bob-y-1
Bob 全量视图含 4 条笔迹：建卡笔迹 + Alice 两条 + Bob 一条，互不覆盖
```

手动复现（两个浏览器/两种身份）：

1. 用户 A 打开 `/studio/1/:cardId`，用户 B 打开同一 URL；
2. 两人**都先停留**到页面显示同一版本（如 v3），然后几乎同时各画一笔并等自动同步；
3. 先提交者的画布立刻出现自己的笔迹；后提交者的**同一响应**带回先到者的笔迹；
4. 先提交者在 ≤6s 轮询（或点「立即同步/手动拉取」）后也看到后到者的笔迹；
5. 两边最终笔迹集合完全一致，顺序由事件上的 `v` 决定，没有任何一方被覆盖。

## 边界与安全（均有自动化断言）

| 风险 | 处理 | 验证 |
| --- | --- | --- |
| 超大笔迹数据 | 单笔 ≤2000 点、单次 ≤200 笔迹；坐标量化到 3~4 位小数；客户端距离抽点；>32KB 自动 gzip | `test:merge`、e2e F5 |
| 请求体上限 | 原始体 ≤512KB；gzip 解压后 ≤1MB（**压缩炸弹**防护） | e2e F1（1597B→解压 1.5MB 被拒）/F2 |
| 超长文本 | 标题 ≤60、讲解/批注 ≤300 字，超长截断 | e2e F4 |
| 恶意内容 | 清控制字符/零宽/BiDi、尖括号转义、React 文本节点转义；写接口限流 120 次/分 | e2e F3 |
| 撤回已发布标注 | 单条撤回（仅本人/卡片作者）与整卡撤回，均为追加事件，他人不可见 | e2e D |
| 反复追加性能 | 增量 `?since=N`（事件按 v 有序，二分）、走廊只返回摘要不带矢量数据 | e2e G：1500 条，全量 6.5ms / 尾部增量 0.8ms / 列表 0.4ms |

> 说明：性能数字来自容器内单次测量，绝对值随机器变化；关键结论是**增量耗时与历史总长度无关**，
> 走廊列表负载与卡片内笔迹条数无关。另有单卡 8000 事件硬顶，超过提示复刻为新卡片。

## 主要代码位置

- 共享类型/校验/合并内核：`shared/annotations.ts`
- 后端：`api/src/controllers/AnnotationController.ts`、`api/src/services/annotationStore.ts`、路由 `api/routes/index.ts`
- 前端：
  - Canvas（笔锋/贝塞尔/DPR/撤销重做/触摸+手写笔）：`src/components/AnnotationCanvas.tsx`
  - 创作/同步/离线合并：`src/pages/StudioPage.tsx`
  - 走廊、卡片页、审核台：`src/pages/{CorridorPage,CardViewPage,ModerationPage}.tsx`
  - API/gzip/草稿：`src/utils/{annotationApi,annotationGeometry,drafts,identity}.ts`
- 测试：`api/tests/merge.test.ts`（内核）、`api/tests/e2e.ts`（端到端，可独立复现）

## 既有模板说明（Vite + React + TS）

下方为原始 Vite 模板的 ESLint 扩展说明，与本功能无直接关系。

---

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh
