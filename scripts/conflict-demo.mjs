#!/usr/bin/env node
/**
 * 可复现演示：两个人同时在同一张卡片上批注（追加式合并 + 版本号）
 *
 * 运行：node scripts/conflict-demo.mjs
 * 自动启动一个使用独立 JSON 库的 API 服务（端口 3099），跑完自动退出。
 *
 * 覆盖断言：
 *  A. 两人同时基于 v2 append -> 一人成功、一人 409；409 响应里带着对方笔迹
 *  B. 败者用最新版本重试 -> 成功，最终卡片里两人笔迹都在（互不覆盖）
 *  C. 断网重试安全：同一 opId 发两次只画一次
 *  D. 点赞服务端去重：连点三次只 +1，取消后可再点
 *  E. 越界坐标 / 恶意文本 / 超长文本 / 超大请求体 全部被拒
 *  F. 撤回自己的标注是墓碑：追加合并不会让它复活
 *  G. 长日志加载不退化：delta 增量只传新增条目
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const MOD_KEY = 'demo-mod-key';

const A = { 'x-user-id': 'user-alice-0001', 'x-user-name': 'Alice' };
const B = { 'x-user-id': 'user-bob-000002', 'x-user-name': 'Bob' };
const MOD = { 'x-moderator-key': MOD_KEY };
const json = (extra = {}) => ({ 'content-type': 'application/json', ...extra });

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

function op(id, who, x, color = '#00ffc8') {
  return {
    opId: id,
    authorName: who === 'A' ? 'Alice' : 'Bob',
    createdAt: Date.now(),
    payload: {
      kind: 'stroke',
      stroke: {
        color,
        points: [
          [x, 100, 6],
          [x + 50, 200, 4],
          [x + 20, 300, 2],
        ],
      },
    },
  };
}

async function api(method, path, { headers, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: json(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, get raw() {
    return text;
  } };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器未在 15s 内启动');
}

const tmp = mkdtempSync(join(tmpdir(), 'graffiti-demo-'));
const dbPath = join(tmp, 'graffiti.json');

console.log('▶ 启动独立 API 服务（AUTO_APPROVE=1）...');
const server = spawn(
  process.execPath,
  ['--import', 'tsx', join(ROOT, 'api/server.ts')],
  {
    env: { ...process.env, PORT: String(PORT), GRAFFITI_DB: dbPath, AUTO_APPROVE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
server.stdout.on('data', (d) => process.env.DEBUG && process.stdout.write(`[srv] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));

try {
  await waitForServer();

  // ---------- 建卡：Alice 初始 2 笔，版本到 v2 ----------
  console.log('\n▶ 场景：Alice 建卡（2 条笔迹，version=2）');
  const created = await api('POST', '/api/annotations/cards', {
    headers: A,
    body: { specimenId: 1, title: '大肠杆菌鞭毛讲解', ops: [op('op-init-1', 'A', 100), op('op-init-2', 'A', 200)] },
  });
  check('建卡 201', created.status === 201, `status=${created.status}`);
  const cardId = created.data.data.id;
  check('建卡后 version=2', created.data.data.version === 2, `v=${created.data.data.version}`);

  // ---------- A. 两人同时基于 v2 追加 ----------
  console.log('\n▶ 场景：Alice 和 Bob 都基于 v2 同时追加（模拟并发，两个请求都带 baseVersion:2）');
  const [rAlice, rBob] = await Promise.all([
    api('POST', `/api/annotations/cards/${cardId}/append`, {
      headers: A,
      body: { baseVersion: 2, ops: [op('op-alice-3', 'A', 300, '#ff7b29')] },
    }),
    api('POST', `/api/annotations/cards/${cardId}/append`, {
      headers: B,
      body: { baseVersion: 2, ops: [op('op-bob-3', 'B', 700, '#9b59b6')] },
    }),
  ]);
  const ok = rAlice.status === 200 ? rAlice : rBob.status === 200 ? rBob : null;
  const conflict = rAlice.status === 409 ? rAlice : rBob.status === 409 ? rBob : null;
  check('恰好一人成功', ok !== null && conflict !== null,
    `Alice=${rAlice.status}, Bob=${rBob.status}`);
  check('成功者版本推进到 v3', ok?.data?.meta?.version === 3, `meta=${JSON.stringify(ok?.data?.meta)}`);
  check('失败者收到 409', conflict.status === 409);
  const conflictOps = conflict.data.conflict.liveOps;
  const winnerId = ok === rAlice ? A['x-user-id'] : B['x-user-id'];
  const winnerNewOpId = ok === rAlice ? 'op-alice-3' : 'op-bob-3';
  const seesOther = conflictOps.some((o) => o.authorId === winnerId && o.opId === winnerNewOpId);
  check('409 响应里已经能看到对方刚画上去的笔迹（不会互相覆盖）', seesOther,
    `liveOps=${conflictOps.map((o) => `${o.authorId}:${o.opId}`).join(',')}`);
  check('409 给出 serverVersion=3', conflict.data.conflict.serverVersion === 3);

  // ---------- B. 败者合并后用 v3 重试 ----------
  console.log('\n▶ 场景：失败者（Bob/Alice）以 serverVersion=3 重放自己的笔迹');
  const loserOpId = conflict === rAlice ? 'op-alice-3' : 'op-bob-3';
  const loserHeader = conflict === rAlice ? A : B;
  const retry = await api('POST', `/api/annotations/cards/${cardId}/append`, {
    headers: loserHeader,
    body: { baseVersion: 3, ops: [op(loserOpId, conflict === rAlice ? 'A' : 'B', conflict === rAlice ? 300 : 700)] },
  });
  check('重试成功 version=4', retry.status === 200 && retry.data.data.version === 4,
    `status=${retry.status} v=${retry.data?.data?.version}`);
  const finalOps = retry.data.data.liveOps;
  check('最终视野里两人并发笔迹都存在',
    finalOps.some((o) => o.opId === 'op-alice-3') && finalOps.some((o) => o.opId === 'op-bob-3'),
    `ops=${finalOps.map((o) => o.opId).join(',')}`);
  check('最终共 4 条存活标注', finalOps.length === 4, `n=${finalOps.length}`);

  // ---------- C. 幂等重试：同一个 opId 发两次 ----------
  console.log('\n▶ 场景：网络超时后客户端重试，opId 不变');
  const dup1 = await api('POST', `/api/annotations/cards/${cardId}/append`, {
    headers: A,
    body: { baseVersion: 4, ops: [op('op-dup-x', 'A', 400)] },
  });
  const dup2 = await api('POST', `/api/annotations/cards/${cardId}/append`, {
    headers: A,
    // 客户端没拿到响应，baseVersion 还是旧的，但 opId 相同
    body: { baseVersion: 4, ops: [op('op-dup-x', 'A', 400)] },
  });
  check('重复提交不产生新笔迹（第二次幂等返回）', dup2.status === 200,
    `status=${dup2.status}`);
  const afterDup = await api('GET', `/api/annotations/cards/${cardId}`, { headers: A });
  check('笔迹总数仍为 5 而不是 6', afterDup.data.data.liveOps.length === 5,
    `n=${afterDup.data.data.liveOps.length}`);

  // ---------- D. 点赞服务端去重 ----------
  console.log('\n▶ 场景：Bob 手滑连点三次赞');
  await api('POST', `/api/annotations/cards/${cardId}/like`, { headers: B, body: { liked: true } });
  await api('POST', `/api/annotations/cards/${cardId}/like`, { headers: B, body: { liked: true } });
  const like3 = await api('POST', `/api/annotations/cards/${cardId}/like`, { headers: B, body: { liked: true } });
  check('连点三次 likeCount=1 且 likedByMe=true',
    like3.data.data.likeCount === 1 && like3.data.data.likedByMe === true,
    JSON.stringify(like3.data.data));
  const unlike = await api('POST', `/api/annotations/cards/${cardId}/like`, { headers: B, body: { liked: false } });
  check('取消点赞 likeCount=0', unlike.data.data.likeCount === 0);

  // ---------- E. 边界：越界 / 恶意 / 超长 / 超大 ----------
  console.log('\n▶ 边界用例');
  const badCoord = await api('POST', `/api/annotations/cards/${cardId}/append`, {
    headers: A,
    body: { baseVersion: 5, ops: [{ opId: 'bad-coord-0001', payload: { kind: 'stroke', stroke: { color: '#fff', points: [[0, 0, 4], [9999, 0, 4]] } } }] },
  });
  check('越界坐标 400', badCoord.status === 400, badCoord.data?.error);
  const badColor = await api('POST', `/api/annotations/cards/${cardId}/append`, {
    headers: A,
    body: { baseVersion: 5, ops: [{ opId: 'bad-color-0001', payload: { kind: 'stroke', stroke: { color: 'red', points: [[0, 0], [1, 1]] } } }] },
  });
  check('非法颜色 400', badColor.status === 400);
  const xss = await api('POST', '/api/annotations/cards', {
    headers: B,
    body: { specimenId: 1, title: 'xss', ops: [op('evil-card-op01', 'B', 100)], },
  });
  const evilCard = xss.data.data.id;
  const evilNote = await api('POST', `/api/annotations/cards/${evilCard}/append`, {
    headers: B,
    body: {
      baseVersion: 1,
      ops: [{ opId: 'evil-note-0001', payload: { kind: 'note', note: { x: 10, y: 10, text: '<script>alert(1)</script>' } } }],
    },
  });
  check('XSS 文本 400', evilNote.status === 400, evilNote.data?.error);
  const longNote = await api('POST', `/api/annotations/cards/${evilCard}/append`, {
    headers: B,
    body: {
      baseVersion: 1,
      ops: [{ opId: 'long-note-0001', payload: { kind: 'note', note: { x: 10, y: 10, text: '很'.repeat(5000) } } }],
    },
  });
  check('超长文本被截断到 500 字后接受',
    longNote.status === 200 && Array.from(longNote.data.data.liveOps.at(-1).payload.note.text).length === 500);

  // 超大请求体：>256KB 直接 413（拼一个 ~400KB 的 JSON）
  const huge = { baseVersion: 2, ops: [op('huge-op-000001', 'B', 10)], junk: 'x'.repeat(400_000) };
  const hugeRes = await api('POST', `/api/annotations/cards/${cardId}/append`, { headers: B, body: huge });
  check('超大请求体 413', hugeRes.status === 413, `status=${hugeRes.status}`);

  // 超多点数：>600 点的单条笔迹 400
  const pts = Array.from({ length: 601 }, (_, i) => [i % 1000, (i * 7) % 1000, 5]);
  const tooMany = await api('POST', `/api/annotations/cards/${cardId}/append`, {
    headers: A,
    body: { baseVersion: 5, ops: [{ opId: 'too-many-pts-1', payload: { kind: 'stroke', stroke: { color: '#00ffc8', points: pts } } }] },
  });
  check('单条笔迹 >600 采样点 400', tooMany.status === 400, tooMany.data?.error);

  // ---------- 审核状态：pending 卡片对公众不可见 ----------
  console.log('\n▶ 审核状态');
  const pend = await api('POST', '/api/annotations/cards', {
    headers: B,
    body: { specimenId: 2, title: '待审核卡片', ops: [op('pend-op-000001', 'B', 100)] },
  });
  // AUTO_APPROVE 下直接 approved，所以改用审核员驳回来演示状态机
  const pendId = pend.data.data.id;
  const reject = await api('POST', `/api/annotations/moderation/cards/${pendId}`, {
    headers: MOD,
    body: { decision: 'rejected', reviewNote: '演示驳回' },
  });
  check('审核员可驳回', reject.status === 200 && reject.data.data.status === 'rejected');
  const anonSee = await api('GET', `/api/annotations/cards/${pendId}`);
  check('被驳回卡片公众不可见 403', anonSee.status === 403, `status=${anonSee.status}`);
  const approve = await api('POST', `/api/annotations/moderation/cards/${pendId}`, {
    headers: MOD,
    body: { decision: 'approved', reviewNote: '恢复' },
  });
  check('审核员重新通过', approve.status === 200 && approve.data.data.status === 'approved');

  // ---------- F. 撤回自己的标注：墓碑不复活 ----------
  console.log('\n▶ 撤回（墓碑）');
  const wd = await api('POST', `/api/annotations/cards/${cardId}/withdraw-op`, {
    headers: A,
    body: { opId: 'op-init-1' },
  });
  check('撤回自己笔迹 200', wd.status === 200, `status=${wd.status}`);
  check('撤回后存活数减少', wd.data.data.liveOps.every((o) => o.opId !== 'op-init-1'));
  // Bob 基于撤回前版本并发追加，冲突响应里也不应让被撤回的笔迹复活
  const cb = await api('POST', `/api/annotations/cards/${cardId}/append`, {
    headers: B,
    body: { baseVersion: 5, ops: [op('late-bob-op001', 'B', 500)] },
  });
  check('并发冲突快照同样过滤了墓碑',
    cb.status === 409 && cb.data.conflict.liveOps.every((o) => o.opId !== 'op-init-1'));
  const notYours = await api('POST', `/api/annotations/cards/${cardId}/withdraw-op`, {
    headers: B,
    body: { opId: 'op-init-2' }, // Alice 的笔迹
  });
  check('不能撤回别人的标注 403', notYours.status === 403);

  // ---------- G. 长日志：反复追加后的加载性能 ----------
  console.log('\n▶ 长日志性能（同一卡片再追加 400 次）');
  let v = (await api('GET', `/api/annotations/cards/${cardId}`, { headers: A })).data.data.version;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 400; i++) {
    const r = await api('POST', `/api/annotations/cards/${cardId}/append`, {
      headers: A,
      body: { baseVersion: v, ops: [op(`perf-op-${String(i).padStart(4, '0')}`, 'A', 100 + (i % 800))] },
    });
    if (r.status !== 200) throw new Error(`perf append ${i} failed: ${r.status}`);
    v = r.data.data.version;
  }
  const t1 = process.hrtime.bigint();
  const full = await api('GET', `/api/annotations/cards/${cardId}`, { headers: A });
  const t2 = process.hrtime.bigint();
  const delta = await api('GET', `/api/annotations/cards/${cardId}/delta?since=${v - 20}`, { headers: A });
  const t3 = process.hrtime.bigint();
  const fullMs = Number(t2 - t1) / 1e6;
  const deltaMs = Number(t3 - t2) / 1e6;
  console.log(`     全量 GET 返回 ${(JSON.stringify(full.data).length / 1024).toFixed(1)}KB / ${fullMs.toFixed(1)}ms；delta 增量 ${deltaMs.toFixed(1)}ms，条目数=${delta.data.data.entries.length}`);
  check('全量详情在数百条日志下仍 < 300ms', fullMs < 300, `${fullMs.toFixed(1)}ms`);
  check('delta 只返回请求之后的 20 条', delta.data.data.entries.length === 20);
  check('delta 比全量快（或至少同量级）', deltaMs <= fullMs + 20);
  console.log(`     400 次串行 append 总耗时 ${(Number(t1 - t0) / 1e6).toFixed(0)}ms（每次含落盘）`);

  // ---------- 复刻 ----------
  console.log('\n▶ 复刻（把公开卡片笔迹搬到自己标本页继续画）');
  const fork = await api('POST', `/api/annotations/cards/${cardId}/fork`, { headers: B });
  check('复刻 201 且指向来源', fork.status === 201 && fork.data.data.forkedFrom === cardId);
  check('复刻件携带源卡片存活笔迹', fork.data.data.liveOps.length > 10);
  const forkContinue = await api('POST', `/api/annotations/cards/${fork.data.data.id}/append`, {
    headers: B,
    body: { baseVersion: fork.data.data.version, ops: [op('fork-new-op0001', 'B', 50)] },
  });
  check('复刻后可以继续追加', forkContinue.status === 200);

  console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠️ 有失败'}：${pass} 通过 / ${fail} 失败`);
} catch (e) {
  console.error('演示脚本异常：', e);
  fail++;
} finally {
  server.kill('SIGTERM');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
