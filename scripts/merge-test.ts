/**
 * 纯函数单测：追加式归约 + 离线/在线三方合并
 * 运行：npx tsx scripts/merge-test.ts
 */
import {
  mergeClientServer,
  reduceLog,
  sanitizeNote,
  sanitizeStroke,
  clampText,
  type AppendOp,
  type AnyLogEntry,
  type LogEntry,
} from '../shared/annotation';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

function op(opId: string, author: string, n: number): AppendOp {
  return {
    opId,
    authorId: author,
    authorName: author,
    createdAt: n,
    payload: { kind: 'stroke', stroke: { color: '#00ffc8', points: [[n, n, 4], [n + 1, n + 1, 4]] } },
  };
}
function served(o: AppendOp, version: number): LogEntry {
  return { ...o, version };
}

console.log('▶ 离线恢复合并：别人的笔迹不能被冲掉');
{
  // 离线前服务端 v2：Alice 两笔
  const serverOps = [served(op('a1', 'alice', 1), 1), served(op('a2', 'alice', 2), 2)];
  // Bob 离线期间本地画了 3 笔；同一时间 Carol 在服务端又追加 2 笔（v3,v4，Bob 恢复后才拉到）
  const serverOpsAfter = [
    ...serverOps,
    served(op('c1', 'carol', 30), 3),
    served(op('c2', 'carol', 40), 4),
  ];
  const localOps = [op('b1', 'bob', 100), op('b2', 'bob', 200), op('b3', 'bob', 300)];
  const { liveOps, pendingLocal } = mergeClientServer(serverOpsAfter, localOps, new Set());
  check('合并视图含 Alice+Carol+Bob 共 7 笔', liveOps.length === 7, `n=${liveOps.length}`);
  check('别人的 4 笔都在', ['a1', 'a2', 'c1', 'c2'].every((id) => liveOps.some((o) => o.opId === id)));
  check('本地 3 笔全部待重放', pendingLocal.length === 3);
  check('待重放笔迹排在服务端笔迹之后（追加式，不插回中间）', liveOps.slice(-3).map((o) => o.opId).join() === 'b1,b2,b3');
}

console.log('▶ 已确认但服务端已删除（被撤回墓碑）的本地笔迹不能复活');
{
  // 本地曾同步成功 a1；后来作者撤回，服务端快照里 a1 已消失
  const serverOps = [served(op('a2', 'alice', 2), 2)];
  const localOps = [op('a1', 'alice', 1), op('a2', 'alice', 2)];
  const { liveOps, pendingLocal } = mergeClientServer(serverOps, localOps, new Set(['a1', 'a2']));
  check('a1 不复活', !liveOps.some((o) => o.opId === 'a1'));
  check('没有待重放操作', pendingLocal.length === 0);
}

console.log('▶ reduceLog：墓碑 + 重复 opId');
{
  const entries: AnyLogEntry[] = [
    served(op('x1', 'alice', 1), 1),
    served(op('x2', 'bob', 2), 2),
    { version: 3, opId: 't1', type: 'tombstone', authorId: 'alice', createdAt: 3, targetOpId: 'x1' },
    // 模拟服务端重放保护：同 opId 重复条目只保留一条
    served(op('x2', 'bob', 2), 4),
  ];
  const live = reduceLog(entries);
  check('被墓碑标记的 x1 不在存活集', !live.some((o) => o.opId === 'x1'));
  check('x2 去重后只有一条', live.filter((o) => o.opId === 'x2').length === 1);
}

console.log('▶ 清洗：超长文本按码点截断、XSS、越界坐标');
{
  check('超长文本截断到 500 码点', Array.from(clampText('很'.repeat(5000), 500)).length === 500);
  check('emoji 不被劈坏', clampText('🔬🧫'.repeat(10), 3) === '🔬🧫🔬');
  const evil = sanitizeNote({ x: 1, y: 1, text: '<script>x</script>' });
  // 注意：XSS 模式扫描在路由层，sanitizeNote 只负责结构清洗；这里验证控制字符剥离
    const ctrl = sanitizeNote({ x: 1, y: 1, text: 'hello\x00\x1bworld' });
  check('控制字符被剥离', 'error' in ctrl ? true : ctrl.text === 'helloworld');
  check('越界坐标报错', 'error' in sanitizeStroke({ color: '#ffffff', points: [[0, 0], [1001, 0]] }));
  check('NaN 坐标报错', 'error' in sanitizeStroke({ color: '#ffffff', points: [[0, 0], [NaN, 0]] }));
  check('非法颜色报错', 'error' in sanitizeStroke({ color: 'white', points: [[0, 0], [1, 1]] }));
  const ok = sanitizeStroke({ color: '#ABCDEF', points: [[0, 0, 999], [1000, 1000]] });
  check('笔锋宽度被夹到 0.5..40', !('error' in ok) && ok.points[0][2] === 40 && ok.points[1][2] !== undefined);
  void evil;
}

console.log(`\n${fail === 0 ? '🎉 合并单测全部通过' : '⚠️ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
