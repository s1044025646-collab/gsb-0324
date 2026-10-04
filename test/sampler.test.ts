const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.POISSON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poisson-test-"));

// 测试针对构建产物 dist 运行（npm test 会先执行构建）
const { sample, annulusRadius, ParamError, EPS_REL } = require("../dist/sampler");
const { validatePointSet } = require("../dist/validate");
const { createRng, RNG_VERSION } = require("../dist/rng");
const db = require("../dist/db");

test("相同种子与参数产生完全相同的点序列", () => {
  const p = { width: 100, height: 80, r: 5, k: 30, seed: 42 };
  const a = sample(p);
  const b = sample(p);
  assert.deepEqual(a.points, b.points);
  assert.ok(a.points.length > 10);
});

test("生成点满足最小距离（独立全点对核对网格判断）", () => {
  const p = { width: 60, height: 40, r: 3, k: 30, seed: 7 };
  const r = sample(p);
  const check = validatePointSet(60, 40, 3, r.points);
  assert.equal(check.ok, true, JSON.stringify(check.issues.slice(0, 5)));
  assert.ok(check.minDistance >= 3 - 1e-6);
});

test("所有点位于左闭右开矩形内", () => {
  const r = sample({ width: 50, height: 50, r: 4, k: 30, seed: 1 });
  for (const pt of r.points) {
    assert.ok(pt.x >= 0 && pt.x < 50 && pt.y >= 0 && pt.y < 50);
  }
});

test("窄矩形（宽小于 r）正常生成", () => {
  const r = sample({ width: 2, height: 100, r: 5, k: 30, seed: 9 });
  assert.ok(r.points.length >= 1);
  const check = validatePointSet(2, 100, 5, r.points);
  assert.equal(check.ok, true);
});

test("r 大于矩形边长时只放得下初始点", () => {
  const r = sample({ width: 10, height: 10, r: 50, k: 30, seed: 3 });
  assert.equal(r.points.length, 1);
  assert.equal(r.status, "complete");
});

test("恰好等于 r 的距离按接受处理", () => {
  const check = validatePointSet(100, 100, 5, [{ x: 10, y: 10 }, { x: 15, y: 10 }]);
  assert.equal(check.ok, true);
  assert.equal(check.minDistance, 5);
});

test("非法尺寸与参数给出明确错误码", () => {
  assert.throws(() => sample({ width: 0, height: 10, r: 1, k: 30, seed: 1 }), (e: any) => e.code === "INVALID_WIDTH");
  assert.throws(() => sample({ width: 10, height: -1, r: 1, k: 30, seed: 1 }), (e: any) => e.code === "INVALID_HEIGHT");
  assert.throws(() => sample({ width: 10, height: 10, r: 0, k: 30, seed: 1 }), (e: any) => e.code === "INVALID_R");
  assert.throws(() => sample({ width: 10, height: 10, r: 1, k: 0, seed: 1 }), (e: any) => e.code === "INVALID_K");
  assert.throws(() => sample({ width: 10, height: 10, r: 1, k: 30, seed: 1.5 }), (e: any) => e.code === "INVALID_SEED");
});

test("重复点被独立校验标记", () => {
  const check = validatePointSet(100, 100, 5, [{ x: 10, y: 10 }, { x: 10, y: 10 }]);
  assert.equal(check.ok, false);
  assert.ok(check.issues.some((i: any) => i.code === "DUPLICATE"));
});

test("右上边界排除：x=width 或 y=height 判为越界", () => {
  const check = validatePointSet(100, 100, 1, [{ x: 100, y: 50 }, { x: 50, y: 100 }]);
  assert.equal(check.ok, false);
  assert.equal(check.issues.filter((i: any) => i.code === "OUT_OF_BOUNDS").length, 2);
});

test("过近点对（跨网格边界）被独立校验标记", () => {
  const cell = 5 / Math.SQRT2;
  const pts = [{ x: cell - 0.01, y: 10 }, { x: cell + 3.99, y: 10 }];
  const check = validatePointSet(100, 80, 5, pts);
  assert.equal(check.ok, false);
  assert.ok(check.issues.some((i: any) => i.code === "TOO_CLOSE"));
});

test("极小预算导致部分生成并明确标记", () => {
  const r = sample({ width: 100, height: 80, r: 5, k: 30, seed: 42, maxPoints: 5 });
  assert.equal(r.status, "partial");
  assert.equal(r.points.length, 5);
  assert.match(r.reason, /部分生成/);
  const r2 = sample({ width: 100, height: 80, r: 5, k: 30, seed: 42, maxAttempts: 20 });
  assert.equal(r2.status, "partial");
  assert.ok(r2.summary.attempts <= 20);
});

test("网格规模预算超限报错", () => {
  assert.throws(
    () => sample({ width: 1000, height: 1000, r: 0.01, k: 30, seed: 1, maxGridCells: 100 }),
    (e: any) => e.code === "GRID_BUDGET_EXCEEDED"
  );
});

test("候选环形半径范围 [r, 2r) 独立核对", () => {
  for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.999999]) {
    const rad = annulusRadius(5, u);
    assert.ok(rad >= 5 && rad < 10, `u=${u} -> ${rad}`);
  }
  assert.equal(annulusRadius(5, 0), 5);
});

test("RNG 确定性：同种子同序列，版本号固定", () => {
  const a = createRng(123);
  const b = createRng(123);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  assert.equal(RNG_VERSION, "mulberry32@1");
  const c = createRng(123);
  for (let i = 0; i < 1000; i++) {
    const v = c();
    assert.ok(v >= 0 && v < 1);
  }
});

test("解释明细截短不影响采样结果", () => {
  const p = { width: 100, height: 80, r: 5, k: 30, seed: 42 };
  const full = sample(p);
  const truncated = sample({ ...p, maxExplain: 3 });
  assert.deepEqual(full.points, truncated.points);
  assert.equal(truncated.events.length, 3);
  assert.equal(truncated.summary.explainTruncated, true);
});

test("SQLite 往返一致：保存后读取与内存结果相同（模拟重启后读取）", () => {
  const p = { width: 40, height: 30, r: 4, k: 30, seed: 77 };
  const r = sample(p);
  const runId = db.saveRun(p, r);
  const loaded = db.getPoints(runId);
  assert.deepEqual(loaded, r.points);
  const run = db.getRun(runId);
  assert.equal(run.seed, 77);
  assert.equal(run.rng_version, "mulberry32@1");
  assert.equal(run.select_rule, "lifo-v1");
});

