#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runBridson } from "./sampler.js";
import { Store } from "./db.js";
import { ApiError } from "./errors.js";
import { DEFAULT_LIMITS, validateParams } from "./validate.js";
import { queryNear, verifyPoints } from "./verify.js";
import { bruteForceMinDistance } from "./sampler.js";
import { pointsToCSV, rejectsToCSV } from "./exporters.js";
import { startServer } from "./server.js";

interface CliArgs {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): { cmd: string; positional: string[]; args: CliArgs } {
  const args: CliArgs = {};
  const positional: string[] = [];
  for (const token of argv) {
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) args[token.slice(2, eq)] = token.slice(eq + 1);
      else args[token.slice(2)] = true;
    } else {
      positional.push(token);
    }
  }
  return { cmd: positional[0] ?? "help", positional: positional.slice(1), args };
}

function dataDir(): string {
  const dir = process.env.BRIDSON_DATA_DIR
    ? resolve(process.env.BRIDSON_DATA_DIR)
    : join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function num(v: string | boolean | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new ApiError("VALIDATION_ERROR", `参数 ${name} 必须是有限数`, 422);
  }
  return n;
}

function printPointsTable(points: { idx: number; x: number; y: number; kind: string }[]): void {
  if (points.length === 0) {
    console.log("（无点）");
    return;
  }
  console.log("idx\t x\t\t y\t\t kind");
  for (const p of points) {
    console.log(`${p.idx}\t ${p.x.toFixed(6)}\t ${p.y.toFixed(6)}\t ${p.kind}`);
  }
}

async function main(): Promise<void> {
  const { cmd, positional, args } = parseArgs(process.argv.slice(2));

  if (cmd === "help" || args.help) {
    console.log(`
Bridson 泊松圆盘采样后端（仅 API + CLI，数据保存在项目内 data/ 目录）

用法:
  node dist/cli.js generate --width=100 --height=80 --r=10 --k=30 --seed=demo [--max-points=..] [--max-attempts=..]
  node dist/cli.js list
  node dist/cli.js get <id> [--format=csv]
  node dist/cli.js points <id> [--format=csv]
  node dist/cli.js rejects <id>
  node dist/cli.js near <id> --x=.. --y=.. --radius=..
  node dist/cli.js verify <id>               # 独立验证已存点集
  node dist/cli.js verify-file <points.json> --width=.. --height=.. --r=..
  node dist/cli.js export <id> --kind=points|rejects --out=file.csv
  node dist/cli.js serve [--port=0]         # 默认 0 = 自动选择空闲端口
  node dist/cli.js demo

环境变量:
  BRIDSON_DATA_DIR   数据目录（默认 ./data）
`);
    return;
  }

  const store = new Store(join(dataDir(), "bridson.sqlite"));

  try {
    if (cmd === "generate") {
      const params = validateParams({
        width: num(args.width, "width"),
        height: num(args.height, "height"),
        r: num(args.r, "r"),
        k: Number(args.k ?? 30),
        seed: String(args.seed ?? "default"),
      });
      const limits = { ...DEFAULT_LIMITS };
      if (args["max-points"] !== undefined) limits.maxPoints = Number(args["max-points"]);
      if (args["max-attempts"] !== undefined) limits.maxAttempts = Number(args["max-attempts"]);
      if (args["max-explanations"] !== undefined) limits.maxExplanations = Number(args["max-explanations"]);

      const result = runBridson({ ...params, limits });
      const id = store.saveRun(params, limits, result);
      const run = store.getRun(id)!;
      console.log(JSON.stringify({
        id,
        params: { width: run.width, height: run.height, r: run.r, k: run.k, seed: run.seed },
        prngVersion: run.prngVersion,
        activeSelectionRule: run.activeSelectionRule,
        status: run.status,
        stopReason: run.stopReason,
        pointCount: run.pointCount,
        attempts: run.attempts,
        gridCells: `${run.gridCellsX}x${run.gridCellsY}`,
        rejectSummary: store.rejectSummary(id),
        explanationTruncated: run.explanationTruncated === 1,
      }, null, 2));
      if (args.print) printPointsTable(result.points);
      return;
    }

    if (cmd === "list") {
      const runs = store.listRuns();
      if (runs.length === 0) {
        console.log("（数据库中还没有点集）");
        return;
      }
      console.log("id\t状态\t点数\t尝试\tw×h\tr\tseed");
      for (const r of runs) {
        console.log(
          `${r.id}\t${r.status}\t${r.pointCount}\t${r.attempts}\t${r.width}x${r.height}\t${r.r}\t${r.seed}`,
        );
      }
      return;
    }

    const idCmd = ["get", "points", "rejects", "near", "verify", "export"];
    if (idCmd.includes(cmd)) {
      const id = Number(positional[0]);
      const run = store.getRun(id);
      if (!run) throw new ApiError("NOT_FOUND", `点集 #${id} 不存在`, 404);

      if (cmd === "get") {
        const points = store.getPoints(id);
        if (args.format === "csv") {
          process.stdout.write(pointsToCSV(points));
        } else {
          const { minDist } = bruteForceMinDistance(points);
          console.log(JSON.stringify({
            run,
            rejectSummary: store.rejectSummary(id),
            minPairDistance: minDist,
          }, null, 2));
          printPointsTable(points);
        }
        return;
      }

      if (cmd === "points") {
        const points = store.getPoints(id);
        if (args.format === "csv") process.stdout.write(pointsToCSV(points));
        else printPointsTable(points);
        return;
      }

      if (cmd === "rejects") {
        const rejects = store.getRejects(id);
        console.log(`拒绝分类（已存储明细 ${rejects.length} 条，截短: ${
          run.explanationTruncated === 1 ? "是" : "否"
        }，总候选尝试 ${run.attempts}）:`);
        console.log(store.rejectSummary(id));
        console.log("attempt\t锚点\tx\t\ty\t\treason\t\tnear/dist2");
        for (const rej of rejects.slice(0, 50)) {
          const tail =
            rej.reason === "too_close"
              ? `too_close\t#${rej.nearIdx} d2=${rej.dist2?.toFixed(4)}`
              : "out_of_bounds";
          console.log(
            `${rej.attempt}\t#${rej.activeIdx}\t${rej.x.toFixed(4)}\t${rej.y.toFixed(4)}\t${tail}`,
          );
        }
        if (rejects.length > 50) console.log(`... 其余 ${rejects.length - 50} 条见 API/CSV 导出`);
        return;
      }

      if (cmd === "near") {
        const x = num(args.x, "x");
        const y = num(args.y, "y");
        const radius = num(args.radius, "radius");
        console.log(JSON.stringify(queryNear(store.getPoints(id), { x, y }, radius), null, 2));
        return;
      }

      if (cmd === "verify") {
        const points = store.getPoints(id);
        const result = verifyPoints(run.width, run.height, run.r, points);
        console.log(JSON.stringify(result, null, 2));
        if (!result.passed) process.exitCode = 2;
        return;
      }

      if (cmd === "export") {
        const kind = String(args.kind ?? "points");
        const out = String(args.out ?? (kind === "rejects" ? `rejects-${id}.csv` : `points-${id}.csv`));
        const csv =
          kind === "rejects"
            ? rejectsToCSV(store.getRejects(id))
            : pointsToCSV(store.getPoints(id));
        writeFileSync(out, csv, "utf8");
        console.log(`已导出 ${kind} 到 ${resolve(out)}`);
        return;
      }
    }

    if (cmd === "verify-file") {
      const file = positional[0];
      const body = JSON.parse(readFileSync(file, "utf8"));
      const width = num(args.width ?? body.width, "width");
      const height = num(args.height ?? body.height, "height");
      const r = num(args.r ?? body.r, "r");
      const points = body.points;
      const result = verifyPoints(width, height, r, points);
      store.saveVerification(null, width, height, r, result);
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 2;
      return;
    }

    if (cmd === "serve") {
      const port = args.port !== undefined ? Number(args.port) : undefined;
      const { server, port: actualPort } = await startServer({
        dataDir: dataDir(),
        port,
      });
      console.log(`HTTP API 已启动: http://127.0.0.1:${actualPort}`);
      console.log("按 Ctrl+C 停止");
      process.on("SIGINT", () => {
        server.close(() => process.exit(0));
      });
      return;
    }

    if (cmd === "demo") {
      const { runDemo } = await import("./demo.js");
      await runDemo(store);
      return;
    }

    throw new ApiError("VALIDATION_ERROR", `未知命令: ${cmd}（试 help）`, 422);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2));
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main();
