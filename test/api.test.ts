const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.POISSON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poisson-api-test-"));

const { startServer } = require("../dist/server");

async function post(port: number, p: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("API 端到端：生成、读取、附近查询、解释、校验、导出", async () => {
  const { server, port } = await startServer(0);
  try {
    assert.ok(port > 0); // 默认自动选空闲端口

    const gen = await post(port, "/api/samples", { width: 50, height: 40, r: 4, k: 30, seed: 11 });
    assert.equal(gen.status, 201);
    assert.ok(gen.body.pointCount > 0);
    const runId = gen.body.runId;

    const pts = await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/points`)).json();
    assert.equal(pts.points.length, gen.body.pointCount);

    const near = await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/nearby?x=25&y=20&limit=3`)).json();
    assert.equal(near.nearest.length, 3);
    assert.ok(near.nearest[0].distance <= near.nearest[1].distance);

    const explain = await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/explain`)).json();
    assert.ok(explain.summary.attempts >= explain.summary.accepted);

    const val = await post(port, "/api/validate", {
      width: 50, height: 40, r: 4,
      points: [{ x: 1, y: 1 }, { x: 2, y: 1 }],
    });
    assert.equal(val.body.ok, false);
    assert.ok(val.body.issues.some((i: any) => i.code === "TOO_CLOSE"));

    const csv = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/export?format=csv`);
    assert.match(await csv.text(), /^idx,x,y\n/);

    const bad = await post(port, "/api/samples", { width: -5, height: 40, r: 4, k: 30, seed: 11 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_WIDTH");

    const missing = await fetch(`http://127.0.0.1:${port}/api/runs/99999/points`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "RUN_NOT_FOUND");
  } finally {
    server.close();
  }
});

