import * as http from "node:http";
import { AddressInfo } from "node:net";
import { ParamError, sample, SampleParams } from "./sampler";
import { validatePointSet } from "./validate";
import * as db from "./db";

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ParamError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

function toCsv(points: { x: number; y: number }[]): string {
  return "idx,x,y\n" + points.map((p, i) => `${i},${p.x},${p.y}`).join("\n") + "\n";
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      // POST /api/samples 生成点集
      if (req.method === "POST" && path === "/api/samples") {
        const body = (await readBody(req)) as SampleParams;
        const result = sample(body);
        const runId = db.saveRun(body, result);
        sendJson(res, 201, {
          runId, status: result.status, reason: result.reason,
          rngVersion: result.rngVersion, selectRule: result.selectRule,
          pointCount: result.points.length, summary: result.summary,
        });
        return;
      }

      // GET /api/runs 列表
      if (req.method === "GET" && path === "/api/runs") {
        sendJson(res, 200, db.listRuns().map((r) => ({ ...r, budgets: JSON.parse(r.budgets), summary: JSON.parse(r.summary) })));
        return;
      }

      const runMatch = path.match(/^\/api\/runs\/(\d+)(\/points|\/nearby|\/explain|\/export)?$/);
      if (req.method === "GET" && runMatch) {
        const runId = Number(runMatch[1]);
        const sub = runMatch[2] ?? "";
        const run = db.getRun(runId);
        if (!run) {
          sendError(res, 404, "RUN_NOT_FOUND", `运行 ${runId} 不存在`);
          return;
        }
        if (sub === "" || sub === "/points") {
          sendJson(res, 200, { runId, points: db.getPoints(runId) });
        } else if (sub === "/nearby") {
          const x = Number(url.searchParams.get("x"));
          const y = Number(url.searchParams.get("y"));
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            sendError(res, 400, "INVALID_QUERY", "需要提供数值参数 x 和 y");
            return;
          }
          const pts = db.getPoints(runId);
          const withDist = pts
            .map((p, i) => ({ idx: i, x: p.x, y: p.y, distance: Math.hypot(p.x - x, p.y - y) }))
            .sort((a, b) => a.distance - b.distance);
          const limit = Math.min(withDist.length, Number(url.searchParams.get("limit")) || 10);
          sendJson(res, 200, { runId, query: { x, y }, nearest: withDist.slice(0, limit) });
        } else if (sub === "/explain") {
          const summary = JSON.parse(run.summary);
          sendJson(res, 200, {
            runId, status: run.status, reason: run.reason,
            rngVersion: run.rng_version, selectRule: run.select_rule,
            summary, events: db.getEvents(runId),
          });
        } else if (sub === "/export") {
          const format = url.searchParams.get("format") ?? "json";
          const pts = db.getPoints(runId);
          if (format === "csv") {
            res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
            res.end(toCsv(pts));
          } else if (format === "json") {
            sendJson(res, 200, { runId, params: { width: run.width, height: run.height, r: run.r, k: run.k, seed: run.seed }, points: pts });
          } else {
            sendError(res, 400, "INVALID_FORMAT", "format 仅支持 json 或 csv");
          }
        }
        return;
      }

      // POST /api/validate 独立校验任意候选点集
      if (req.method === "POST" && path === "/api/validate") {
        const body = (await readBody(req)) as { width: number; height: number; r: number; points: { x: number; y: number }[]; runId?: number };
        const result = validatePointSet(body.width, body.height, body.r, body.points);
        const vid = db.saveValidation(body.runId ?? null, result, result.ok);
        sendJson(res, 200, { validationId: vid, ...result });
        return;
      }

      sendError(res, 404, "NOT_FOUND", `未知路由 ${req.method} ${path}`);
    } catch (e) {
      if (e instanceof ParamError) {
        sendError(res, 400, e.code, e.message);
      } else {
        sendError(res, 500, "INTERNAL", String(e));
      }
    }
  });
}

// 默认端口 0 = 由系统分配空闲端口
export function startServer(port = 0): Promise<{ server: http.Server; port: number }> {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

if (require.main === module) {
  const argPort = process.argv.includes("--port")
    ? Number(process.argv[process.argv.indexOf("--port") + 1])
    : 0;
  startServer(argPort).then(({ port }) => {
    console.log(`API 服务已启动: http://127.0.0.1:${port}`);
  });
}
