import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { runBridson } from "../src/sampler.js";
import { DEFAULT_LIMITS } from "../src/validate.js";
import { createApp } from "../src/server.js";
import type { Server } from "node:http";

let dir: string;
let store: Store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bridson-test-"));
  store = new Store(join(dir, "bridson.sqlite"));
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const params = { width: 60, height: 40, r: 8, k: 25, seed: "persist-seed" };

test("持久化：保存后重新打开数据库（模拟重启）读取一致", () => {
  const result = runBridson({ ...params, limits: DEFAULT_LIMITS });
  const id = store.saveRun(params, DEFAULT_LIMITS, result);

  const reopened = new Store(join(dir, "bridson.sqlite"));
  const runRow = reopened.getRun(id);
  assert.ok(runRow);
  assert.equal(runRow!.pointCount, result.points.length);
  assert.equal(runRow!.seed, "persist-seed");
  const reloaded = reopened.getPoints(id);
  assert.deepEqual(
    reloaded.map((p) => [p.x, p.y]),
    result.points.map((p) => [p.x, p.y]),
  );

  // 同种子再次执行，与库里首次点序列完全一致
  const again = runBridson({ ...params, limits: DEFAULT_LIMITS });
  assert.deepEqual(
    again.points.map((p) => [p.x, p.y]),
    reloaded.map((p) => [p.x, p.y]),
  );
  reopened.close();
});

test("拒绝汇总与明细可读取", () => {
  const res = runBridson({ ...params, seed: "summary-seed", limits: DEFAULT_LIMITS });
  const id = store.saveRun({ ...params, seed: "summary-seed" }, DEFAULT_LIMITS, res);
  const summary = store.rejectSummary(id);
  assert.equal(
    summary.outOfBounds + summary.tooClose,
    summary.totalStored,
  );
  const rejects = store.getRejects(id);
  assert.equal(rejects.length, summary.totalStored);
});

test("HTTP API 端到端：生成 → 读取 → near → 注入验证 → CSV", async () => {
  const server: Server = createApp(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 50, height: 50, r: 7, k: 20, seed: "http-seed" }),
    });
    assert.equal(created.status, 201);
    const createdBody: any = await created.json();
    const id = createdBody.id;
    assert.ok(createdBody.points.length > 0);

    const got: any = await (await fetch(`${base}/api/runs/${id}`)).json();
    assert.equal(got.run.id, id);
    assert.equal(got.points.length, got.run.pointCount);

    const first = got.points[0];
    const near: any = await (
      await fetch(`${base}/api/runs/${id}/near?x=${first.x}&y=${first.y}&radius=20`)
    ).json();
    assert.ok(near.neighbors.length >= 1);
    assert.equal(near.nearest.idx, 0);
    assert.equal(near.nearest.distance, 0);

    // 注入过近点对：即使通过 runId 也不采信任何标记，全点对独立检查
    const badVerify: any = await (
      await fetch(`${base}/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          width: 50,
          height: 50,
          r: 7,
          points: [
            { x: 5, y: 5 },
            { x: 6, y: 5 },
          ],
        }),
      })
    ).json();
    assert.equal(badVerify.passed, false);
    assert.ok(badVerify.issues.some((i: any) => i.type === "too_close"));

    // 对合法点集按 runId 独立验证
    const goodVerify: any = await (
      await fetch(`${base}/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: id,
          width: 50,
          height: 50,
          r: 7,
        }),
      })
    ).json();
    assert.equal(goodVerify.passed, true);

    // 部分生成预算
    const partial: any = await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          width: 500,
          height: 500,
          r: 5,
          k: 30,
          seed: "p",
          limits: { maxPoints: 3 },
        }),
      })
    ).json();
    assert.equal(partial.run.status, "partial");
    assert.equal(partial.run.stopReason, "point_budget");

    // CSV 导出
    const csv = await (await fetch(`${base}/api/runs/${id}/points?format=csv`)).text();
    assert.ok(csv.startsWith("idx,x,y,kind,accepted_attempt"));

    // 错误码
    const bad = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: -1, height: 10, r: 5, k: 10, seed: "x" }),
    });
    assert.equal(bad.status, 422);
    const badBody: any = await bad.json();
    assert.equal(badBody.error.code, "VALIDATION_ERROR");

    const nf = await fetch(`${base}/api/runs/99999`);
    assert.equal(nf.status, 404);
  } finally {
    server.close();
  }
});
