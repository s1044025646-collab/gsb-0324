import { sample, SampleParams, ParamError } from "./sampler";
import { validatePointSet } from "./validate";
import * as db from "./db";
import { startServer } from "./server";
import * as fs from "node:fs";

function argNum(args: string[], name: string, def?: number): number {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    if (def !== undefined) return def;
    throw new ParamError("MISSING_ARG", `缺少参数 --${name}`);
  }
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v)) throw new ParamError("INVALID_ARG", `--${name} 不是数值`);
  return v;
}

function argStr(args: string[], name: string, def?: string): string {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    if (def !== undefined) return def;
    throw new ParamError("MISSING_ARG", `缺少参数 --${name}`);
  }
  return args[i + 1];
}

function toCsv(points: { x: number; y: number }[]): string {
  return "idx,x,y\n" + points.map((p, i) => `${i},${p.x},${p.y}`).join("\n") + "\n";
}

function printPoints(points: { x: number; y: number }[], limit = 50) {
  console.log("idx\tx\ty");
  points.slice(0, limit).forEach((p, i) => console.log(`${i}\t${p.x.toFixed(6)}\t${p.y.toFixed(6)}`));
  if (points.length > limit) console.log(`... 共 ${points.length} 个点，仅显示前 ${limit} 个`);
}

function printNearest(points: { x: number; y: number }[]) {
  let minD = Infinity, pair = "";
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (d < minD) { minD = d; pair = `${i}-${j}`; }
    }
  }
  console.log(points.length >= 2 ? `最近点距: ${minD.toFixed(6)} (点对 ${pair})` : "点数不足，无最近点距");
}

function readParams(args: string[]): SampleParams {
  return {
    width: argNum(args, "width"),
    height: argNum(args, "height"),
    r: argNum(args, "r"),
    k: argNum(args, "k", 30),
    seed: argNum(args, "seed", 42),
    maxPoints: argNum(args, "max-points", 1_000_000),
    maxAttempts: argNum(args, "max-attempts", 10_000_000),
    maxGridCells: argNum(args, "max-grid-cells", 4_000_000),
    maxExplain: argNum(args, "max-explain", 10_000),
  };
}

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "serve": {
      const port = argNum(args, "port", 0);
      const { port: actual } = await startServer(port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}`);
      return; // 保持进程运行
    }
    case "generate": {
      const params = readParams(args);
      const result = sample(params);
      const runId = db.saveRun(params, result);
      console.log(`runId=${runId} status=${result.status} 点数=${result.points.length}`);
      console.log(`原因: ${result.reason}`);
      console.log(`摘要: 尝试=${result.summary.attempts} 接受=${result.summary.accepted} 拒绝=${result.summary.rejected} (越界=${result.summary.rejectOutOfBounds} 过近=${result.summary.rejectTooClose})`);
      return;
    }
    case "list": {
      for (const r of db.listRuns()) {
        console.log(`#${r.id} ${r.created_at} ${r.width}x${r.height} r=${r.r} k=${r.k} seed=${r.seed} status=${r.status}`);
      }
      return;
    }
    case "points": {
      const runId = argNum(args, "run");
      const run = db.getRun(runId);
      if (!run) throw new ParamError("RUN_NOT_FOUND", `运行 ${runId} 不存在`);
      printPoints(db.getPoints(runId), argNum(args, "limit", 50));
      return;
    }
    case "nearby": {
      const runId = argNum(args, "run");
      const x = argNum(args, "x");
      const y = argNum(args, "y");
      const run = db.getRun(runId);
      if (!run) throw new ParamError("RUN_NOT_FOUND", `运行 ${runId} 不存在`);
      const pts = db.getPoints(runId)
        .map((p, i) => ({ idx: i, ...p, d: Math.hypot(p.x - x, p.y - y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, argNum(args, "limit", 10));
      for (const p of pts) console.log(`#${p.idx} (${p.x.toFixed(6)}, ${p.y.toFixed(6)}) 距离=${p.d.toFixed(6)}`);
      return;
    }
    case "explain": {
      const runId = argNum(args, "run");
      const run = db.getRun(runId);
      if (!run) throw new ParamError("RUN_NOT_FOUND", `运行 ${runId} 不存在`);
      const summary = JSON.parse(run.summary);
      console.log(`status=${run.status} 原因: ${run.reason}`);
      console.log(`RNG=${run.rng_version} 活动点选择=${run.select_rule}`);
      console.log(`尝试=${summary.attempts} 接受=${summary.accepted} 拒绝=${summary.rejected} 越界=${summary.rejectOutOfBounds} 过近=${summary.rejectTooClose} 解释截短=${summary.explainTruncated}`);
      const events = db.getEvents(runId);
      const limit = argNum(args, "limit", 30);
      for (const e of events.slice(0, limit)) {
        console.log(`${e.kind}\t(${e.x.toFixed(4)}, ${e.y.toFixed(4)})\t${e.detail ?? ""}`);
      }
      if (events.length > limit) console.log(`... 共 ${events.length} 条明细`);
      return;
    }
    case "validate": {
      // 从 JSON 文件读取候选点集独立校验
      const file = argStr(args, "file");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const result = validatePointSet(data.width, data.height, data.r, data.points);
      const vid = db.saveValidation(null, result, result.ok);
      console.log(`validationId=${vid} ok=${result.ok} 点数=${result.pointCount} 最小距离=${result.minDistance?.toFixed(6) ?? "n/a"}`);
      for (const issue of result.issues.slice(0, 20)) console.log(`${issue.code} i=${issue.i}${issue.j !== undefined ? ` j=${issue.j}` : ""} ${issue.detail}`);
      if (result.issues.length > 20) console.log(`... 共 ${result.issues.length} 个问题`);
      return;
    }
    case "export": {
      const runId = argNum(args, "run");
      const format = argStr(args, "format", "json");
      const run = db.getRun(runId);
      if (!run) throw new ParamError("RUN_NOT_FOUND", `运行 ${runId} 不存在`);
      const pts = db.getPoints(runId);
      if (format === "csv") {
        process.stdout.write(toCsv(pts));
      } else if (format === "json") {
        console.log(JSON.stringify({ runId, params: { width: run.width, height: run.height, r: run.r, k: run.k, seed: run.seed }, points: pts }, null, 2));
      } else {
        throw new ParamError("INVALID_FORMAT", "format 仅支持 json 或 csv");
      }
      return;
    }
    case "nearest": {
      const runId = argNum(args, "run");
      const run = db.getRun(runId);
      if (!run) throw new ParamError("RUN_NOT_FOUND", `运行 ${runId} 不存在`);
      printNearest(db.getPoints(runId));
      return;
    }
    default:
      console.log(`用法: node dist/cli.js <命令> [参数]
命令:
  serve [--port N]                       启动 API 服务（默认自动选空闲端口）
  generate --width W --height H --r R [--k K] [--seed S] [--max-points N] [--max-attempts N] [--max-explain N]
  list                                   列出历史运行
  points --run ID [--limit N]            显示点表
  nearby --run ID --x X --y Y [--limit N] 查询某点附近距离
  explain --run ID [--limit N]           接受/拒绝原因摘要与明细
  nearest --run ID                       最近点距
  validate --file points.json            独立校验候选点集
  export --run ID [--format json|csv]    导出点集`);
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((e) => {
    if (e instanceof ParamError) {
      console.error(`错误 [${e.code}] ${e.message}`);
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  });
}
