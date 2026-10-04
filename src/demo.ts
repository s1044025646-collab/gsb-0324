import { bruteForceMinDistance, runBridson } from "./sampler.js";
import { DEFAULT_LIMITS } from "./validate.js";
import { verifyPoints } from "./verify.js";
import type { Store } from "./db.js";

function heading(title: string): void {
  console.log("\n================================================================");
  console.log(title);
  console.log("================================================================");
}

/**
 * 固定脚本演示：
 *  A. 固定种子下的正常点集（并独立全点对核对）
 *  B. 极小预算导致部分生成（partial）
 *  C. 向验证接口注入一对跨网格边界但距离 < r 的点
 */
export async function runDemo(store: Store): Promise<void> {
  // ---- A. 正常点集 ----
  heading("A. 固定种子正常点集  100x80, r=10, k=30, seed=demo-2026");
  const paramsA = { width: 100, height: 80, r: 10, k: 30, seed: "demo-2026" };
  const resultA = runBridson({ ...paramsA, limits: DEFAULT_LIMITS });
  const idA = store.saveRun(paramsA, DEFAULT_LIMITS, resultA);
  const { minDist } = bruteForceMinDistance(resultA.points);
  console.log(`run #${idA}`);
  console.log(`点数=${resultA.points.length} 总候选尝试=${resultA.attempts}`);
  console.log(
    `状态=${resultA.status} 停止原因=${resultA.stopReason} 网格=${resultA.gridCellsX}x${resultA.gridCellsY}`,
  );
  console.log(
    `独立全点对最小距离=${minDist?.toFixed(8)}  r=${paramsA.r}  合格=${minDist !== null && minDist >= paramsA.r ? "是" : "否"}`,
  );
  console.log("前 5 个点（点序列确定性输出）:");
  for (const p of resultA.points.slice(0, 5)) {
    console.log(`  #${p.idx} (${p.x.toFixed(6)}, ${p.y.toFixed(6)}) ${p.kind}`);
  }
  const summaryA = store.rejectSummary(idA);
  console.log("拒绝分类（存储明细）:", summaryA);

  // ---- B. 极小预算的部分生成 ----
  heading("B. 极小预算部分生成  maxPoints=5, maxAttempts=100000");
  const paramsB = { ...paramsA };
  const limitsB = { ...DEFAULT_LIMITS, maxPoints: 5, maxAttempts: 100_000 };
  const resultB = runBridson({ ...paramsB, limits: limitsB });
  const idB = store.saveRun(paramsB, limitsB, resultB);
  console.log(`run #${idB}`);
  console.log(
    `点数=${resultB.points.length} 状态=${resultB.status} 停止原因=${resultB.stopReason} 活动列表剩余=${resultB.activeRemaining}`,
  );
  console.log("=> 已明确标记 partial；不宣称填满矩形或得到最优排列。");

  // ---- C. 注入跨网格边界但过近的一对点 ----
  heading("C. 注入跨网格边界但距离 < r 的点对（独立验证应拒绝）");
  const r = 10;
  const cell = r / Math.SQRT2; // ≈7.071
  // 让两点落在相邻网格单元，但间距只有 1 < 10
  const p1 = { x: cell * 1.9, y: cell * 1.1 };
  const p2 = { x: p1.x + 1, y: p1.y };
  const injected = [
    { x: 5, y: 5 },
    { x: 30, y: 30 },
    p1,
    p2,
  ];
  const verdict = verifyPoints(100, 80, r, injected);
  console.log(`通过=${verdict.passed} 问题数=${verdict.issueCount} 全点对最小距离=${verdict.minPairDistance?.toFixed(6)} (< r=${r})`);
  for (const issue of verdict.issues) {
    console.log(
      `  [${issue.type}] #${issue.idx} <-> #${issue.otherIdx ?? "-"} 距离=${issue.distance?.toFixed(4) ?? "-"}`,
    );
  }

  heading("演示完成");
  console.log(`数据库中的点集: A=#${idA}(completed), B=#${idB}(partial)`);
  console.log("可用 CLI 查看，例如: node dist/cli.js get " + idA);
}
