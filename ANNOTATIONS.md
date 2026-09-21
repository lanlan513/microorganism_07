# 显微镜视野里的涂鸦共享馆

在标本图上圈鞭毛、标分裂中的细胞、写两句讲解，生成一张**讲解卡片**挂进公共走廊。
别人能看、点赞、在**同一个视野**上追加批注，也能把别人的标注**复刻**到自己的标本页继续画。

- 标注一律是**服务端矢量笔迹**（归一化 0..1000 的点列 + 每点笔锋宽度），不是截图
- 追加式合并 + 版本号：两人同时画，先到的成功，后到的收 409 并拿到对方全部笔迹，重放后**双方笔迹都在**
- 公开卡片带审核状态（pending / approved / rejected / withdrawn）
- 点赞在服务端按用户 ID 去重
- 撤销已发布的标注 = 追加墓碑（tombstone），日志只增不改
- 离线草稿进 IndexedDB，恢复网络后先拉服务端再重放本地，**不覆盖任何人的笔迹**

## 运行

```bash
npm install
npm run dev          # Vite 5173 + Express 3001（/api 已代理）
```

演示用配置（环境变量）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3001 | API 端口 |
| `GRAFFITI_DB` | `api/data/graffiti.json` | JSON 库路径 |
| `MODERATOR_KEY` | `demo-mod-key` | 审核员密钥（`x-moderator-key` 头） |
| `AUTO_APPROVE` | 关 | `1` 时新建卡片免审（仅演示/测试用） |

页面：

- `/gallery` 公共走廊（默认只列 approved；勾选"审核员模式"输入密钥看待审队列）
- `/microbe/:id` 标本页有「在这个视野上圈划讲解」入口
- `/studio/:specimenId` 新建讲解卡片；`/studio/card/:cardId` 在已有卡片上追加
- `/cards/:cardId` 卡片详情：点赞 / 追加 / 复刻 / 撤回

## 可复现：两人同时画，冲突时双方笔迹都必须在

一条命令全自动复现（会自己起一个端口 3099、独立临时库的 API，跑完退出）：

```bash
npm run test:conflict
```

逐步对应输出（`scripts/conflict-demo.mjs`）：

1. Alice 建卡，2 条笔迹，`version=2`
2. Alice、Bob **同时** `POST /cards/:id/append`，请求体都带 `"baseVersion": 2`
3. 服务端只允许版本匹配者写入：恰好一人 200（版本推进到 3），另一人 **409**
4. **409 响应体** `conflict.liveOps` 里包含对方刚画上去的笔迹（断言：失败者立刻能看到对方）
5. 失败者用 `baseVersion: 3` 重放自己原来的 `opId`
6. 最终卡片 4 条存活标注，`op-alice-3` 与 `op-bob-3` **同时存在**，没有覆盖

纯合并逻辑的单测（离线恢复、墓碑不复活、去重、清洗）：

```bash
npm run test:merge
```

### 用 curl 手工复现

```bash
# 终端 A（Alice）和终端 B（Bob）几乎同时发出，都基于 v2
curl -H 'content-type: application/json' -H 'x-user-id: user-alice-0001' \
  -X POST localhost:3001/api/annotations/cards/<id>/append \
  -d '{"baseVersion":2,"ops":[{"opId":"a3",...}]}'
curl -H 'content-type: application/json' -H 'x-user-id: user-bob-000002' \
  -X POST localhost:3001/api/annotations/cards/<id>/append \
  -d '{"baseVersion":2,"ops":[{"opId":"b3",...}]}'
# 一个 200 一个 409；409 的 conflict.liveOps 就是对方笔迹，拿 serverVersion 重放即可
```

前端等价行为：打开同一张卡片两人同时画，后提交者看到提示
"检测到 N 次并发，已自动合并对方笔迹"——hook 收到 409 后用响应里的 `liveOps`
更新基线，再把本地笔迹逐条重放（`src/annotations/useAnnotationEditor.ts` + `offline.ts:syncDraft`）。

## 数据模型（追加式日志）

```
card { id, specimenId, title, authorId, status, likes[] }
card.log: [
  { version:1, opId, authorId, payload: stroke|note },   # 笔迹/批注只能 append
  { version:2, opId, ... },
  { version:3, type:'tombstone', targetOpId:'...' },      # 撤回也是 append，不删历史
]
```

- `version = log.length`，append 的条件是 `baseVersion === log.length`，这就是并发裁决点
- 同一 `opId` 重复提交视为成功（断网重试不会画出两笔）
- 渲染前 `reduceLog` 过滤墓碑、按 `opId` 去重（前后端共用 `shared/annotation.ts`）

## 边界覆盖

| 风险 | 处理 | 复现/位置 |
|---|---|---|
| 超大笔迹 | 单笔迹 ≤600 点、单操作 ≤32KB、整请求 ≤256KB（超出 413）、gzip 传输 | demo 的「超大请求体 413」「>600 点 400」 |
| 超长文本 | 标题 60 / 批注 500 **Unicode 码点**截断，emoji 不劈坏；控制字符剥离 | merge-test |
| 恶意内容 | 拒绝 `<script>`、`javascript:`、`onerror=`、`<iframe>` 等；React 文本默认转义；颜色仅接受 `#rrggbb`；坐标强制 0..1000 | demo 的「XSS 文本 400」 |
| 撤回标注 | 只能撤**自己**的笔迹；追加墓碑；别人并发拿到的冲突快照同样已过滤墓碑 | demo 的「撤回（墓碑）」段 |
| 点赞刷数 | 服务端 `likes[]` 去重，取消可再点 | demo 连点三次只 +1 |
| 长日志加载退化 | 走廊列表只返回摘要（无笔迹）；`GET /cards/:id/delta?since=v` 增量同步；400 次追加后全量详情实测 ~2ms/86KB，delta 只回 20 条 | demo 的「长日志性能」段 |
| 离线 | IndexedDB 草稿；上线先 GET 服务端现状，再重放 pending；已确认但服务端已撤回的笔迹不复活 | merge-test 第 1-2 段 |
| 审核 | 非 approved 卡片对公众 403，pending 仅作者/审核员可见；审核中卡片只允许作者追加；复刻仅限 approved | demo + 门控 curl |

## 前端笔迹

`src/annotations/drawingEngine.ts`：

- Pointer Events 统一鼠标 / 触摸 / 手写笔，`touch-action:none`
- 手写笔按 `pressure`、其他按运笔速度（快细慢粗）融合出笔锋宽度
- 相邻点中点二次贝塞尔平滑；分段 `lineWidth` 呈现粗细变化
- canvas 物理像素 = CSS 尺寸 × `devicePixelRatio`（上限 3x），`setTransform` 后按 CSS 像素绘制
- 撤销 / 重做各保留 **100 步**（要求 ≥20）
- 输出字段坐标矢量点列，坐标与设备无关

## 生产化备注

JSON 文件库是为零依赖演示选的；换成 SQLite/Postgres 时只需重写
`AnnotationStore`，对应：`cards`、`card_log`（`(card_id, version)` 唯一索引 = 版本裁决）、
`likes`（`(card_id, user_id)` 唯一 = 点赞去重）三张表。长日志可再加分页/快照归档。
