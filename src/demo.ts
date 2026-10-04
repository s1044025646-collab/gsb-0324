import { sample } from "./sampler";
import { validatePointSet } from "./validate";
import * as db from "./db";

// 演示：
// 1) 固定种子正常生成
// 2) 极小预算导致部分生成
// 3) 向独立校验接口注入一对跨网格边界但过近的点
export function runDemo(): void {
  console.log("=== 演示 1: 固定种子正常生成 (100x80, r=5, k=30, seed=42) ===");
  const p1 = { width: 100, height: 80, r: 5, k: 30, seed: 42 };
  const r1 = sample(p1);
  const runId1 = db.saveRun(p1, r1);
  console.log(`runId=${runId1} status=${r1.status} 点数=${r1.points.length} 尝试=${r1.summary.attempts}`);
  console.log(`拒绝: 越界=${r1.summary.rejectOutOfBounds} 过近=${r1.summary.rejectTooClose}`);
  const check1 = validatePointSet(100, 80, 5, r1.points);
  console.log(`独立全点对校验: ok=${check1.ok} 最小距离=${check1.minDistance?.toFixed(6)}`);

  console.log("\n=== 演示 2: 极小预算导致部分生成 (maxPoints=5) ===");
  const p2 = { ...p1, maxPoints: 5 };
  const r2 = sample(p2);
  const runId2 = db.saveRun(p2, r2);
  console.log(`runId=${runId2} status=${r2.status} 点数=${r2.points.length}`);
  console.log(`原因: ${r2.reason}`);

  console.log("\n=== 演示 3: 注入跨网格边界但过近的一对点 ===");
  // r=5 时网格边长 = 5/sqrt(2) ≈ 3.5355，两点分居相邻网格边界两侧，距离 4 < 5
  const cell = 5 / Math.SQRT2;
  const injected = [
    { x: cell - 0.01, y: 10 },
    { x: cell + 3.99, y: 10 }, // 与上一点距离 4.0，跨越网格边界
  ];
  const check3 = validatePointSet(100, 80, 5, injected);
  console.log(`注入点: (${injected[0].x.toFixed(4)},10) 与 (${injected[1].x.toFixed(4)},10)，距离=4.0 < r=5`);
  console.log(`独立校验: ok=${check3.ok}`);
  for (const issue of check3.issues) console.log(`  ${issue.code}: ${issue.detail}`);
}

if (require.main === module) runDemo();
