import { test } from "node:test";
import assert from "node:assert/strict";
import { runBridson, bruteForceMinDistance } from "../src/sampler.js";
import { DEFAULT_LIMITS, validateParams } from "../src/validate.js";
import { createPrng, PRNG_VERSION } from "../src/prng.js";
import { ApiError } from "../src/errors.js";
import { verifyPoints } from "../src/verify.js";

function run(overrides: Partial<Parameters<typeof runBridson>[0]> = {}) {
  return runBridson({
    width: 100,
    height: 80,
    r: 10,
    k: 30,
    seed: "t",
    limits: DEFAULT_LIMITS,
    ...overrides,
  });
}

test("基本采样：全部点落在左闭右开矩形内", () => {
  const res = run();
  assert.ok(res.points.length > 10);
  assert.equal(res.status, "completed");
  assert.equal(res.stopReason, "active_list_exhausted");
  for (const p of res.points) {
    assert.ok(p.x >= 0 && p.x < 100, `x=${p.x}`);
    assert.ok(p.y >= 0 && p.y < 80, `y=${p.y}`);
  }
  assert.equal(res.points[0].kind, "initial");
});

test("最小距离：网格邻域判定与独立全点对检查一致", () => {
  const res = run();
  const { minDist } = bruteForceMinDistance(res.points);
  assert.ok(minDist !== null);
  assert.ok(minDist! >= 10, `minDist=${minDist}`);
});

test("同版本同参数完全可复现（同进程 + 点序列）", () => {
  const a = run({ seed: "repeatable-xyz", k: 40 });
  const b = run({ seed: "repeatable-xyz", k: 40 });
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.rejects, b.rejects);
  assert.equal(a.attempts, b.attempts);
  assert.equal(a.prngVersion, PRNG_VERSION);
  assert.equal(a.activeSelectionRule, "fifo_front");
});

test("不同种子产生不同结果", () => {
  const a = run({ seed: "s1" });
  const b = run({ seed: "s2" });
  assert.notDeepEqual(a.points, b.points);
});

test("候选圆环半径独立核对：rho 落在 [r, 2r) 且分布对面积均匀", () => {
  // 直接按采样器公式重放 PRNG：初始点消耗 2 个，之后每候选 2 个
  const prng = createPrng("annulus-check");
  const r = 10;
  prng.next();
  prng.next();
  const radii: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const u2 = prng.next();
    prng.next();
    radii.push(r * Math.sqrt(1 + 3 * u2));
  }
  for (const rho of radii) assert.ok(rho >= r && rho < 2 * r);

  // 对面积均匀 => (rho^2 - r^2) / ((2r)^2 - r^2) 应在 [0,1) 近似均匀
  const bins = new Array(10).fill(0);
  for (const rho of radii) {
    const v = (rho * rho - r * r) / (3 * r * r);
    bins[Math.min(9, Math.floor(v * 10))]++;
  }
  const expected = radii.length / 10;
  for (const c of bins) {
    assert.ok(Math.abs(c - expected) / expected < 0.1, "面积均匀分桶偏差过大");
  }
});

test("预算：maxPoints 触发 partial，不宣称填满", () => {
  const res = run({ limits: { ...DEFAULT_LIMITS, maxPoints: 5 } });
  assert.equal(res.status, "partial");
  assert.equal(res.stopReason, "point_budget");
  assert.ok(res.points.length <= 5);
});

test("预算：maxAttempts 触发 partial", () => {
  const res = run({
    width: 1000,
    height: 1000,
    r: 5,
    limits: { ...DEFAULT_LIMITS, maxAttempts: 50 },
  });
  assert.equal(res.status, "partial");
  assert.equal(res.stopReason, "attempt_budget");
  assert.equal(res.attempts, 50);
});

test("网格预算超限报 GRID_LIMIT_EXCEEDED", () => {
  assert.throws(
    () => run({ r: 0.001, limits: { ...DEFAULT_LIMITS, maxGridCells: 100 } }),
    (err: unknown) => err instanceof ApiError && err.code === "GRID_LIMIT_EXCEEDED",
  );
});

test("窄矩形与 r 大于边长：仍可生成合法单点或多点", () => {
  const narrow = run({ width: 3, height: 100, r: 10 });
  assert.ok(narrow.points.length >= 1);
  for (const p of narrow.points) assert.ok(p.x >= 0 && p.x < 3);
  const { minDist } = bruteForceMinDistance(narrow.points);
  if (minDist !== null) assert.ok(minDist >= 10);

  const bigR = run({ width: 5, height: 5, r: 20 });
  assert.equal(bigR.points.length, 1); // 圆环候选必然出界，活动点移除
  assert.equal(bigR.status, "completed");
});

test("恰在距离边界：dist == r 接受（独立验证同样通过）", () => {
  // 构造两点距离恰好 10（平方 100，浮点精确表示）
  const pts = [
    { x: 0, y: 0 },
    { x: 6, y: 8 },
  ];
  const verdict = verifyPoints(20, 20, 10, pts);
  assert.equal(verdict.passed, true);
  assert.ok(Math.abs((verdict.minPairDistance ?? 0) - 10) < 1e-12);
});

test("跨网格边界但过近的点对被拒绝", () => {
  const r = 10;
  const cell = r / Math.SQRT2;
  const p1 = { x: cell * 1.9, y: cell * 1.1 };
  const p2 = { x: p1.x + 1, y: p1.y };
  assert.notEqual(Math.floor(p1.x / cell), Math.floor(p2.x / cell));
  const verdict = verifyPoints(100, 80, r, [p1, p2]);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.issues.some((i) => i.type === "too_close"));
});

test("验证接口：右上边界排除与重复点", () => {
  const edge = verifyPoints(10, 10, 1, [
    { x: 10, y: 5 },
    { x: 5, y: 10 },
    { x: 10, y: 10 },
    { x: 0, y: 0 },
  ]);
  assert.equal(edge.issues.filter((i) => i.type === "out_of_bounds").length, 3);

  const dup = verifyPoints(10, 10, 0.1, [
    { x: 1, y: 1 },
    { x: 1, y: 1 },
  ]);
  assert.ok(dup.issues.some((i) => i.type === "duplicate"));
});

test("参数校验：非法尺寸、r、k、种子", () => {
  for (const bad of [
    { width: 0, height: 80, r: 10, k: 30, seed: "x" },
    { width: -1, height: 80, r: 10, k: 30, seed: "x" },
    { width: 100, height: 80, r: NaN, k: 30, seed: "x" },
    { width: 100, height: 80, r: 10, k: 0, seed: "x" },
    { width: 100, height: 80, r: 10, k: 1.5, seed: "x" },
    { width: 100, height: 80, r: 10, k: 30, seed: "" },
  ]) {
    assert.throws(
      () => validateParams(bad),
      (err: unknown) => err instanceof ApiError && err.code === "VALIDATION_ERROR",
    );
  }
});

test("解释明细截短不影响采样本身", () => {
  const smallExplain = run({
    limits: { ...DEFAULT_LIMITS, maxExplanations: 3 },
  });
  const normal = run();
  assert.deepEqual(smallExplain.points, normal.points);
  assert.ok(smallExplain.rejects.length <= 3);
  assert.equal(smallExplain.explanationTruncated, true);
});

test("拒绝原因分类包含 out_of_bounds 与（通常）too_close", () => {
  const res = run();
  const reasons = new Set(res.rejects.map((r) => r.reason));
  assert.ok(reasons.has("out_of_bounds"));
  // too_close 事件若存在，dist2 必须 < r²
  for (const rej of res.rejects) {
    if (rej.reason === "too_close") {
      assert.ok(rej.dist2 !== undefined && rej.dist2 < 100);
    }
  }
});
