import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AnnotationCard,
  type AnnotationOp,
  type CardEvent,
  mergeCommit,
  normalizeOps,
  sanitizeText,
  eventsSince,
  visibleRecords,
  genId,
} from '../../shared/annotations.js';

const alice = { id: 'user_alice', name: 'Alice' };
const bob = { id: 'user_bob', name: 'Bob' };

function newCard(): AnnotationCard {
  const now = 1000;
  return {
    id: 'c1',
    specimenId: 1,
    title: 't',
    note: 'n',
    authorId: alice.id,
    authorName: alice.name,
    status: 'draft',
    version: 0,
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

function stroke(id: string): AnnotationOp {
  return {
    id,
    type: 'stroke',
    color: '#00ffc8',
    width: 0.006,
    points: [
      { x: 0.1, y: 0.1, p: 0.5, t: 0 },
      { x: 0.2, y: 0.2, p: 0.6, t: 10 },
    ],
  };
}

test('两人同时基于 v1 追加：追加式 fast-forward 合并，谁先谁后由版本决定，双方笔迹都不丢', () => {
  const card = newCard();

  // 初始状态：v1 有一条公共笔迹
  mergeCommit(card, 0, [stroke('base-0')], alice, 1000);
  assert.equal(card.version, 1);

  // Alice 与 Bob 都基于 v1 同时各画两条（真实并发：同一时刻都只看到 v1）
  const aliceOps = [stroke('alice-1'), stroke('alice-2')];
  const bobOps = [stroke('bob-1'), stroke('bob-2')];

  // 服务端串行落地：Alice 先到
  const ra = mergeCommit(card, 1, aliceOps, alice, 2000);
  assert.equal(ra.version, 3, 'Alice 提交后版本 1→3');
  assert.deepEqual(ra.accepted, ['alice-1', 'alice-2']);
  // Alice 响应里的增量 = 她自己那批（base=1）
  assert.equal(ra.events.length, 2);

  // Bob 后到——他的 baseVersion 仍然是 1（落后），但服务端不拒绝、不覆盖，
  // 而是把他的笔迹 fast-forward 到 v3 之后
  const rb = mergeCommit(card, 1, bobOps, bob, 2001);
  assert.equal(rb.version, 5, 'Bob 提交后版本 3→5（他的两条各占一个版本）');
  assert.deepEqual(rb.accepted, ['bob-1', 'bob-2']);

  // 关键断言 1：日志里 5 个 add 事件一个不少（base + alice×2 + bob×2）
  const adds = card.events.filter((e) => e.kind === 'add');
  assert.equal(adds.length, 5);
  // 关键断言 2：版本顺序决定先后——Alice 的笔迹 v2/v3，Bob 的 v4/v5
  const order = adds.map((e) => (e.kind === 'add' ? e.record.id : ''));
  assert.deepEqual(order, ['base-0', 'alice-1', 'alice-2', 'bob-1', 'bob-2']);
  const versions = adds.map((e) => e.v);
  assert.deepEqual(versions, [1, 2, 3, 4, 5]);

  // 关键断言 3：Bob 的响应包含 base(v1) 之后的全部事件——Alice 的两条也在里面。
  // 即 Bob 立刻就能看到对方的笔迹，而不是被自己的提交覆盖掉。
  const bobSeesIds = rb.events.filter((e) => e.kind === 'add').map((e) => (e.kind === 'add' ? e.record.id : ''));
  assert.deepEqual(bobSeesIds, ['alice-1', 'alice-2', 'bob-1', 'bob-2'], 'Bob 必须看到 Alice 的笔迹');

  // 关键断言 4：Alice 下次增量同步（since=3）只拿到 Bob 的两条，不会重绘自己的
  const aliceCatchUp = eventsSince(card, 3).filter((e) => e.kind === 'add');
  assert.deepEqual(
    aliceCatchUp.map((e) => (e.kind === 'add' ? e.record.id : '')),
    ['bob-1', 'bob-2'],
    'Alice 增量同步后也看到 Bob 的笔迹',
  );

  // 折叠后的可见笔迹 = 5，互不覆盖
  assert.equal(visibleRecords(card.events).length, 5);
});

test('失败重试安全：同一个 op id 重复提交按幂等去重，不产生重复笔迹、不白涨版本', () => {
  const card = newCard();
  const op = stroke('op-x');
  mergeCommit(card, 0, [op], alice, 1);
  assert.equal(card.version, 1);

  // 网络超时后客户端原样重试
  const retry = mergeCommit(card, 1, [op], alice, 2);
  assert.deepEqual(retry.accepted, []);
  assert.deepEqual(retry.duplicates, ['op-x']);
  assert.equal(card.version, 1, '重复 id 不涨版本');
  assert.equal(card.events.length, 1);

  // 新旧混发：新的入库，旧的跳过
  const mixed = mergeCommit(card, 1, [op, stroke('op-y')], alice, 3);
  assert.deepEqual(mixed.accepted, ['op-y']);
  assert.deepEqual(mixed.duplicates, ['op-x']);
  assert.equal(card.version, 2);
});

test('撤回是追加标记事件：笔迹仍在日志里，但对其他人折叠时不可见，作者可见', () => {
  const card = newCard();
  mergeCommit(card, 0, [stroke('s1'), stroke('s2')], alice, 1);
  card.events.push({ v: 3, kind: 'retract-op', opId: 's1', by: alice.id });
  card.version = 3;
  const s1rec = card.events.find(
    (e): e is Extract<CardEvent, { kind: 'add' }> => e.kind === 'add' && e.record.id === 's1',
  );
  s1rec!.record.retracted = true;

  assert.equal(visibleRecords(card.events).length, 1, '普通视角只看到未撤回的 s2');
  const authorView = visibleRecords(card.events, { includeRetracted: true });
  assert.equal(authorView.length, 2, '作者视角 s1 仍在（带 retracted 标记）');
  assert.ok(authorView.find((r) => r.id === 's1')?.retracted);
});

test('边界：超大笔迹点数、非法坐标、坏颜色、坏 id 一律拒绝', () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
      return '';
    } catch (e) {
      return (e as { code?: string }).code ?? '';
    }
  };

  assert.equal(
    codeOf(() =>
      normalizeOps([
        {
          id: 'bigg',
          type: 'stroke',
          color: '#00ffc8',
          width: 0.006,
          points: Array.from({ length: 2001 }, (_, i) => ({ x: 0.1 + i * 0.0001, y: 0.1, p: 0.5, t: i })),
        },
      ]),
    ),
    'STROKE_TOO_LONG',
  );

  assert.equal(
    codeOf(() =>
      normalizeOps([
        {
          id: 'farr',
          type: 'stroke',
          color: '#00ffc8',
          width: 0.006,
          points: [
            { x: 5, y: 0.1, p: 0.5, t: 0 },
            { x: 5, y: 0.2, p: 0.5, t: 1 },
          ],
        },
      ]),
    ),
    'POINT_OUT_OF_RANGE',
  );

  assert.equal(
    codeOf(() =>
      normalizeOps([
        { id: 'ccc1', type: 'stroke', color: 'red', width: 0.006, points: [
          { x: 0.1, y: 0.1, p: 0.5, t: 0 },
          { x: 0.2, y: 0.2, p: 0.5, t: 1 },
        ] },
      ]),
    ),
    'COLOR_BAD',
  );

  assert.equal(
    codeOf(() =>
      normalizeOps([
        { id: '../etc/passwd', type: 'stroke', color: '#00ffc8', width: 0.006, points: [
          { x: 0.1, y: 0.1, p: 0.5, t: 0 },
          { x: 0.2, y: 0.2, p: 0.5, t: 1 },
        ] },
      ]),
    ),
    'OP_ID_BAD',
  );
});

test('边界：超长文本截断到 300 字；恶意内容清洗控制字符并转义尖括号', () => {
  const long = '很'.repeat(5000);
  assert.equal(sanitizeText(long, 300).length, 300);

  const evil = '<script>alert(1)</script>\x00<img src=x onerror=alert(1)>';
  const clean = sanitizeText(evil, 300);
  assert.ok(!clean.includes('<'), '不含 <');
  assert.ok(!clean.includes('>'), '不含 >');
  assert.ok(clean.includes('alert(1)'), '正文保留');
  // eslint-disable-next-line no-control-regex -- 断言已剔除控制字符
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(clean), '不含控制字符');

  const text = normalizeOps([
    { id: 'txt1', type: 'text', x: 0.2, y: 0.2, size: 0.03, color: '#ffffff', text: '正常讲解' },
  ]);
  assert.equal(text[0].type, 'text');
});

test('genId 唯一性', () => {
  const set = new Set(Array.from({ length: 1000 }, () => genId()));
  assert.equal(set.size, 1000);
});
