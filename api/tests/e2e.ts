/* eslint-disable @typescript-eslint/no-explicit-any -- E2E 测试用 any 处理动态 JSON */
/**
 * 端到端可复现脚本：真实启动 Express（独立 DB 文件、独立端口），
 * 通过 HTTP 验证整个生命周期与边界。
 *
 * 运行：npx tsx api/tests/e2e.ts
 * 复现并发：见下「场景 B」，两个用户都基于同一版本 POST，断言双方笔迹最终同屏可见。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(process.cwd(), 'api', 'src', 'data', 'e2eStore.json');

const ALICE = { 'X-User-Id': 'user_alice_01', 'X-User-Name': 'Alice' };
const BOB = { 'X-User-Id': 'user_bob_02', 'X-User-Name': 'Bob' };
const CAROL = { 'X-User-Id': 'user_carol_03', 'X-User-Name': 'Carol' };
const MOD = { 'X-Mod-Token': 'moderator' };

let step = 0;
const log = (m: string) => console.log(`  ${String(++step).padStart(2)}. ${m}`);

function stroke(id: string, who: number) {
  // who 让两人笔迹落在画面不同区域，便于核对
  const ox = who === 0 ? 0.15 : 0.55;
  return {
    id,
    type: 'stroke' as const,
    color: who === 0 ? '#00ffc8' : '#ff5c5c',
    width: 0.007,
    points: [
      { x: ox, y: 0.2, p: 0.6, t: 0 },
      { x: ox + 0.1, y: 0.3, p: 0.5, t: 12 },
      { x: ox + 0.05, y: 0.45, p: 0.4, t: 24 },
    ],
  };
}

async function req(
  method: string,
  p: string,
  opts: { headers?: Record<string, string>; body?: unknown; gzip?: boolean } = {},
): Promise<{ status: number; json: any; raw: Buffer }> {
  let body: Buffer | undefined;
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.body !== undefined) {
    body = Buffer.from(JSON.stringify(opts.body));
    if (opts.gzip) {
      body = await gzip(body);
      headers['Content-Encoding'] = 'gzip';
    } else {
      headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(BASE + p, { method, headers, body });
  const raw = Buffer.from(await res.arrayBuffer());
  let json: any = {};
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    /* non-json */
  }
  return { status: res.status, json, raw };
}

async function waitForServer(child: ChildProcess): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/stats');
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
    if (child.killed) throw new Error('server exited early');
  }
  throw new Error('server failed to start');
}

async function main() {
  await rm(DB, { force: true });
  await writeFile(DB, JSON.stringify({ cards: {}, likes: {} }));

  const child = spawn(
    'npx',
    ['tsx', 'api/server.ts'],
    {
      env: { ...process.env, PORT: String(PORT), ANNOTATION_DB: DB },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

  try {
    await waitForServer(child);
    console.log('\n=== 场景 A：建卡 → 送审 → 审核通过 → 走廊可见 ===');
    let r = await req('POST', '/api/cards', {
      headers: ALICE,
      body: {
        specimenId: 1,
        title: '大肠杆菌的鞭毛与二分裂',
        note: '红圈是周生鞭毛；黄箭头处细胞中部内陷，正在二分裂。',
        ops: [stroke('a-stroke-1', 0)],
      },
    });
    assert.equal(r.status, 201);
    const cardId = r.json.data.card.id;
    log(`Alice 建卡 ${cardId}（草稿，带 1 条笔迹），version=${r.json.data.commit.version}`);

    r = await req('GET', `/api/cards/${cardId}`);
    assert.equal(r.status, 403, '未过审卡片对其他人不可见');
    log('未登录/非作者访问草稿 → 403');

    r = await req('POST', `/api/cards/${cardId}/publish`, { headers: ALICE, body: {} });
    assert.equal(r.json.data.status, 'pending');
    log('Alice 发布 → pending');

    r = await req('GET', '/api/moderation/queue', { headers: {} });
    assert.equal(r.status, 403);
    log('无令牌访问审核队列 → 403');

    r = await req('POST', `/api/moderation/cards/${cardId}`, {
      headers: MOD,
      body: { decision: 'approved' },
    });
    assert.equal(r.json.data.status, 'approved');
    log('审核员通过 → approved');

    r = await req('GET', '/api/cards?specimenId=1');
    assert.ok(r.json.data.some((c: any) => c.id === cardId));
    log('公共走廊已能看到这张卡');

    console.log('\n=== 场景 B（核心）：两人同基于一版本并发追加，双方笔迹都不丢 ===');
    // Alice、Bob 各自只看到 v3（建卡 1 + publish status 1 + approve status 1 = 3）
    const before = await req('GET', `/api/cards/${cardId}`, { headers: ALICE });
    const baseV = before.json.data.card.version;
    log(`两人共同的基线版本 v${baseV}`);

    // 同时发出两个 commit（都用同一 baseVersion），Promise.all 制造真实并发
    const [pa, pb] = await Promise.all([
      req('POST', `/api/cards/${cardId}/commits`, {
        headers: ALICE,
        body: { baseVersion: baseV, ops: [stroke('alice-x-1', 0), stroke('alice-x-2', 0)] },
      }),
      req('POST', `/api/cards/${cardId}/commits`, {
        headers: BOB,
        body: { baseVersion: baseV, ops: [stroke('bob-y-1', 1)] },
      }),
    ]);
    assert.equal(pa.status, 200, 'Alice commit 200');
    assert.equal(pb.status, 200, 'Bob commit 200');
    log(`并发提交完成：Alice accepted=${pa.json.data.accepted.length}，Bob accepted=${pb.json.data.accepted.length}`);

    // 谁先落库谁的 version 小；后到者的响应 events 必须同时含「对方 + 自己」
    const order = [
      { name: 'Alice', resp: pa, own: 'alice', other: 'bob' },
      { name: 'Bob', resp: pb, own: 'bob', other: 'alice' },
    ].sort((a, b) => a.resp.json.data.version - b.resp.json.data.version);

    const [first, second] = order;
    const idsOf = (resp: any) =>
      resp.json.data.events.filter((e: any) => e.kind === 'add').map((e: any) => e.record.id);

    const firstIds = idsOf(first.resp);
    console.log(`    - ${first.name} 先落库(v${first.resp.json.data.version})，响应含笔迹: ${firstIds.join(', ')}`);
    assert.ok(firstIds.some((i: string) => i.startsWith(first.own)), '先到者含自己笔迹');

    const secondIds = idsOf(second.resp);
    console.log(`    - ${second.name} 后落库(v${second.resp.json.data.version})，响应含笔迹: ${secondIds.join(', ')}`);
    assert.ok(secondIds.some((i: string) => i.startsWith(second.own)), '后到者含自己笔迹');
    assert.ok(
      secondIds.some((i: string) => i.startsWith(second.other)),
      `关键断言：后到者 ${second.name} 的同一响应必须带回先到者 ${first.name} 的笔迹`,
    );

    // 最终态：两人各自做一次增量同步，双方在自己的画布上都能看到全部 4 条新笔迹
    const finalCard = await req('GET', `/api/cards/${cardId}?since=${baseV}`, { headers: ALICE });
    const finalIds = finalCard.json.data.events
      .filter((e: any) => e.kind === 'add')
      .map((e: any) => e.record.id);
    assert.ok(finalIds.includes('alice-x-1') && finalIds.includes('alice-x-2'), 'Alice 笔迹在');
    assert.ok(finalIds.includes('bob-y-1'), 'Bob 笔迹在');
    log(`增量同步后同屏笔迹（since=v${baseV}）：${finalIds.join(', ')}`);
    assert.ok(finalCard.json.data.card.version >= baseV + 3, '版本号单调推进 3 个 add');

    // Bob 的完整视图也含 Alice 全部笔迹（非覆盖证据）
    const bobView = await req('GET', `/api/cards/${cardId}`, { headers: BOB });
    const allBobIds = bobView.json.data.events.filter((e: any) => e.kind === 'add').map((e: any) => e.record.id);
    assert.ok(allBobIds.includes('a-stroke-1') && allBobIds.includes('alice-x-1') && allBobIds.includes('bob-y-1'));
    log(`Bob 全量视图含 ${allBobIds.length} 条笔迹：建卡笔迹 + Alice 两条 + Bob 一条，互不覆盖`);

    console.log('\n=== 场景 C：点赞服务端去重（幂等 + 取消）===');
    let like = await req('POST', `/api/cards/${cardId}/like`, { headers: CAROL, body: {} });
    assert.equal(like.json.data.likeCount, 1);
    await req('POST', `/api/cards/${cardId}/like`, { headers: CAROL, body: {} }); // 连点
    await req('POST', `/api/cards/${cardId}/like`, { headers: CAROL, body: {} });
    like = await req('POST', `/api/cards/${cardId}/like`, { headers: BOB, body: {} });
    assert.equal(like.json.data.likeCount, 2, 'Carol 连点只算 1 个，+Bob = 2');
    log('Carol 连点 3 次只计 1 赞；不同用户各计 1 → 总数 2');
    const off = await req('POST', `/api/cards/${cardId}/like`, { headers: CAROL, body: {} });
    assert.equal(off.json.data.likeCount, 1);
    log('再点取消 → 总数 1');

    console.log('\n=== 场景 D：撤回单条批注（追加事件，他人不可见）===');
    await req('POST', `/api/cards/${cardId}/ops/bob-y-1/retract`, { headers: BOB, body: {} });
    const bobAfter = await req('GET', `/api/cards/${cardId}`, { headers: BOB });
    assert.ok(
      bobAfter.json.data.events.some((e: any) => e.kind === 'add' && e.record.id === 'bob-y-1' && e.record.retracted),
      '作者仍能看到带 retracted 标记的笔迹',
    );
    const carolAfter = await req('GET', `/api/cards/${cardId}`, { headers: CAROL });
    assert.ok(
      !carolAfter.json.data.events.some((e: any) => e.kind === 'add' && e.record.id === 'bob-y-1'),
      '其他人看不到已撤回笔迹',
    );
    log('Bob 撤回自己笔迹：作者可见痕迹，Carol 完全看不到');

    // 不能撤回别人的
    const forbid = await req('POST', `/api/cards/${cardId}/ops/alice-x-1/retract`, { headers: BOB, body: {} });
    assert.equal(forbid.status, 403);
    log('Bob 撤回 Alice 笔迹 → 403');

    console.log('\n=== 场景 E：复刻（fork）别人的卡片继续画 ===');
    const fork = await req('POST', `/api/cards/${cardId}/fork`, { headers: CAROL, body: {} });
    assert.equal(fork.status, 201);
    const fkid = fork.json.data.id;
    const fkview = await req('GET', `/api/cards/${fkid}`, { headers: CAROL });
    const fkOps = fkview.json.data.events.filter((e: any) => e.kind === 'add');
    assert.ok(fkOps.length >= 3, '复刻带入当前可见笔迹（撤回的不带）');
    assert.ok(
      !fkOps.some((e: any) => e.record.id === 'bob-y-1'),
      '复刻不包含已被撤回的笔迹',
    );
    log(`Carol 复刻得到草稿 ${fkid}，带入 ${fkOps.length} 条可见笔迹（已撤回的排除）`);

    console.log('\n=== 场景 F：边界——体积上限 / gzip / 恶意内容 / 超长文本 ===');
    // F1 gzip 压缩炸弹：150 万个重复 A 解压后 >1MB，但 gzip 体积极小（高压缩比炸弹特征）
    const bomb = JSON.stringify({
      specimenId: 1,
      title: 'bomb',
      note: 'x',
      ops: [{ id: 'bomb1111', type: 'text', x: 0.1, y: 0.1, size: 0.03, color: '#ffffff', text: 'A'.repeat(1_500_000) }],
    });
    const gzBomb = await gzip(Buffer.from(bomb));
    const bombRes = await fetch(BASE + `/api/cards`, {
      method: 'POST',
      headers: { ...ALICE, 'Content-Encoding': 'gzip' },
      body: gzBomb,
    });
    const bombJson = await bombRes.json().catch(() => ({}));
    assert.equal(gzBomb.length < 50_000, true, '前置：gzip 后体积应很小');
    assert.ok(bombRes.status === 400 || bombRes.status === 413, `炸弹应被拒，得到 ${bombRes.status}`);
    log(`gzip 炸弹：压缩后 ${gzBomb.length} 字节 / 解压后 ${(await gunzip(gzBomb)).length} 字节 → ${bombRes.status} ${bombJson.code}`);

    // F2 原始体超 512KB（不压缩）
    const bigRaw = JSON.stringify({
      specimenId: 1,
      title: 'big',
      note: 'y',
      ops: [
        {
          id: 'bigraw01',
          type: 'text',
          x: 0.1,
          y: 0.1,
          size: 0.03,
          color: '#ffffff',
          text: 'B'.repeat(600_000),
        },
      ],
    });
    const bigRes = await fetch(BASE + `/api/cards`, {
      method: 'POST',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: bigRaw,
    });
    assert.notEqual(bigRes.status, 201);
    log(`未压缩 ${bigRaw.length} 字节超大请求 → ${bigRes.status}`);

    // F3 恶意内容被清洗（脚本/控制字符），但卡片仍能建成
    const evil = await req('POST', '/api/cards', {
      headers: ALICE,
      gzip: true,
      body: {
        specimenId: 1,
        title: '<script>x</script>',
        note: '正常讲解\n带控制符\x00与<script>alert(1)</script>',
        ops: [],
      },
    });
    assert.equal(evil.status, 201);
    const evilTitle = evil.json.data.card.title;
    assert.ok(!evilTitle.includes('<') && evilTitle.includes('script'), '标题尖括号转义，正文保留');
    log(`恶意标题清洗为：${evilTitle}（gzip 通道正常）`);

    // F4 超长讲解截断到 300
    const longNote = await req('POST', '/api/cards', {
      headers: ALICE,
      body: { specimenId: 1, title: 'long', note: '字'.repeat(5000), ops: [] },
    });
    assert.equal(longNote.json.data.card.note.length, 300);
    log('超长讲解被截断为 300 字');

    // F5 单条笔迹超 2000 点
    const tooMany = await req('POST', '/api/cards', {
      headers: ALICE,
      body: {
        specimenId: 1,
        title: 'manystroke',
        note: 'z',
        ops: [
          {
            id: 'toomany1',
            type: 'stroke',
            color: '#00ffc8',
            width: 0.006,
            points: Array.from({ length: 2001 }, (_, i) => ({ x: 0.1, y: 0.1 + i * 0.0001, p: 0.5, t: i })),
          },
        ],
      },
    });
    assert.equal(tooMany.json.code, 'STROKE_TOO_LONG');
    log('单条笔迹 2001 点 → STROKE_TOO_LONG');

    console.log('\n=== 场景 G：反复追加后的加载性能不退化（增量 + 分页）===');
    // 建一张卡，灌入 1500 条 add 事件（每条 3 点）
    const perfCard = await req('POST', '/api/cards', {
      headers: ALICE,
      body: { specimenId: 1, title: 'perf', note: '性能卡', ops: [] },
    });
    const pid = perfCard.json.data.card.id;
    const N = 1500;
    const CHUNK = 150;
    let pv = 0;
    for (let i = 0; i < N; i += CHUNK) {
      const ops = [];
      for (let j = 0; j < CHUNK; j++) {
        const k = i + j;
        ops.push({
          id: `p-${k}-${'abcdef'[k % 6]}xxxx`,
          type: 'stroke',
          color: '#00ffc8',
          width: 0.005,
          points: [
            { x: 0.1 + (k % 10) * 0.02, y: 0.1, p: 0.5, t: k },
            { x: 0.2 + (k % 10) * 0.02, y: 0.2, p: 0.5, t: k + 1 },
            { x: 0.15, y: 0.3, p: 0.5, t: k + 2 },
          ],
        });
      }
      const cr = await req('POST', `/api/cards/${pid}/commits`, {
        headers: ALICE,
        body: { baseVersion: pv, ops },
      });
      pv = cr.json.data.version;
    }
    log(`灌入 ${N} 条笔迹，当前 v${pv}`);

    // 全量加载计时
    let t0 = performance.now();
    const full = await req('GET', `/api/cards/${pid}`, { headers: ALICE });
    const tFull = performance.now() - t0;
    const fullAdds = full.json.data.events.filter((e: any) => e.kind === 'add').length;
    assert.equal(fullAdds, N);

    // 增量（since=最新-1，只拿最后 1 条）计时，应明显更小且与历史长度无关
    t0 = performance.now();
    const inc = await req('GET', `/api/cards/${pid}?since=${pv - 1}`, { headers: ALICE });
    const tInc = performance.now() - t0;
    assert.equal(inc.json.data.events.length, 1, '增量只返回 1 条事件');
    log(`全量 ${fullAdds} 条耗时 ${tFull.toFixed(1)}ms；尾部增量 1 条耗时 ${tInc.toFixed(1)}ms`);
    assert.ok(tInc < tFull, '增量加载应快于全量');

    // 走廊列表是摘要（不回传笔迹），计时
    t0 = performance.now();
    await req('GET', '/api/cards?specimenId=1&limit=50', {});
    const tList = performance.now() - t0;
    log(`走廊列表（仅摘要、不含矢量数据）耗时 ${tList.toFixed(1)}ms，与卡片内笔迹条数无关`);

    console.log('\n✅ 全部端到端断言通过');
  } catch (e) {
    console.error('\n❌ E2E 失败:', e);
    process.exitCode = 1;
  } finally {
    // 落盘后关闭
    await new Promise((r) => setTimeout(r, 800));
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    await rm(DB, { force: true }).catch(() => {});
  }
}

main();
