import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { ApiError } from "./errors.js";
import { runBridson } from "./sampler.js";
import { Store } from "./db.js";
import {
  validateCandidatePoints,
  validateLimits,
  validateParams,
} from "./validate.js";
import { queryNear, verifyPoints } from "./verify.js";
import { pointsToCSV, rejectsToCSV, toJSON } from "./exporters.js";

export interface ServerOptions {
  dbPath: string;
  port?: number;
}

/** 请求并绑定一个系统分配的空闲 TCP 端口（端口 0）。 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
  });
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new ApiError("VALIDATION_ERROR", "请求体超过 5MB", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("INVALID_JSON", "请求体不是合法 JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(store: Store): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    const send = (status: number, body: unknown, contentType = "application/json; charset=utf-8") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(
        contentType.startsWith("application/json") ? JSON.stringify(body, null, 2) : (body as string),
      );
    };

    try {
      // GET /health
      if (method === "GET" && pathname === "/health") {
        send(200, { ok: true });
        return;
      }

      // POST /api/runs  生成
      if (method === "POST" && pathname === "/api/runs") {
        const body = await readBody(req);
        const params = validateParams(body);
        const limits = validateLimits(body);
        // 先跑采样；抛错不会写入/覆盖任何已有记录
        const result = runBridson({ ...params, limits });
        const id = store.saveRun(params, limits, result);
        const run = store.getRun(id)!;
        send(201, {
          id,
          run,
          points: result.points,
          rejectSummary: {
            totalAttempts: result.attempts,
            stored: store.rejectSummary(id),
            explanationTruncated: result.explanationTruncated,
          },
        });
        return;
      }

      // GET /api/runs  列表
      if (method === "GET" && pathname === "/api/runs") {
        send(200, { runs: store.listRuns() });
        return;
      }

      const runMatch = pathname.match(/^\/api\/runs\/(\d+)((?:\/[^/]+)*)\/?$/);
      if (method === "GET" && runMatch) {
        const id = Number(runMatch[1]);
        const sub = (runMatch[2] ?? "").replace(/^\/|\/$/g, "");
        const run = store.getRun(id);
        if (!run) throw new ApiError("NOT_FOUND", `点集 #${id} 不存在`, 404);
        const format = url.searchParams.get("format") ?? "json";
        const points = store.getPoints(id);

        if (sub === "") {
          if (format === "csv") {
            send(200, pointsToCSV(points), "text/csv; charset=utf-8");
          } else {
            send(200, {
              run,
              points,
              rejectSummary: store.rejectSummary(id),
            });
          }
          return;
        }

        if (sub === "points") {
          if (format === "csv") {
            send(200, pointsToCSV(points), "text/csv; charset=utf-8");
          } else {
            send(200, { run: { id: run.id, pointCount: run.pointCount }, points });
          }
          return;
        }

        if (sub === "rejects") {
          const rejects = store.getRejects(id);
          if (format === "csv") {
            send(200, rejectsToCSV(rejects), "text/csv; charset=utf-8");
          } else {
            send(200, {
              run: {
                id: run.id,
                attempts: run.attempts,
                explanationTruncated: run.explanationTruncated === 1,
              },
              rejectSummary: store.rejectSummary(id),
              rejects,
            });
          }
          return;
        }

        if (sub === "export") {
          const kind = url.searchParams.get("kind") ?? "points";
          if (kind === "rejects") {
            send(200, rejectsToCSV(store.getRejects(id)), "text/csv; charset=utf-8");
          } else {
            send(200, pointsToCSV(points), "text/csv; charset=utf-8");
          }
          return;
        }

        // GET /api/runs/:id/near?x=&y=&radius=
        if (sub === "near") {
          const x = Number(url.searchParams.get("x"));
          const y = Number(url.searchParams.get("y"));
          const radius = Number(url.searchParams.get("radius") ?? "0");
          if (![x, y, radius].every((v) => Number.isFinite(v) && v >= 0)) {
            throw new ApiError(
              "VALIDATION_ERROR",
              "near 查询需要非负有限数参数 x、y、radius",
              422,
            );
          }
          send(200, queryNear(points, { x, y }, radius));
          return;
        }

        throw new ApiError("NOT_FOUND", `未知资源 /api/runs/${id}/${sub}`, 404);
      }

      // POST /api/verify  独立验证任意点集
      if (method === "POST" && pathname === "/api/verify") {
        const body = await readBody(req);
        // 允许直接传 runId：从库中取点，但验证仍独立重算，不读取 passed 标记
        let points: { x: number; y: number }[];
        let r: number;
        let width: number;
        let height: number;
        let runId: number | null = null;

        if (typeof body.runId === "number") {
          const run = store.getRun(body.runId);
          if (!run) throw new ApiError("NOT_FOUND", `点集 #${body.runId} 不存在`, 404);
          runId = run.id;
          points = store.getPoints(run.id);
          r = run.r;
          width = run.width;
          height = run.height;
        } else {
          const parsed = validateCandidatePoints(body);
          points = parsed.points;
          r = parsed.r;
          width = body.width as number;
          height = body.height as number;
        }

        const result = verifyPoints(width, height, r, points);
        const verificationId = store.saveVerification(
          runId,
          width,
          height,
          r,
          result,
        );
        send(200, { verificationId, ...result });
        return;
      }

      throw new ApiError("NOT_FOUND", `未找到路由 ${method} ${pathname}`, 404);
    } catch (err) {
      if (err instanceof ApiError) {
        send(err.status, {
          error: { code: err.code, message: err.message, details: err.details ?? null },
        });
      } else {
        send(500, {
          error: {
            code: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  });
  return server;
}

export async function startServer(opts: {
  dataDir: string;
  port?: number;
}): Promise<{ server: Server; port: number }> {
  const port = opts.port ?? (await findFreePort());
  const store = new Store(join(opts.dataDir, "bridson.sqlite"));
  const server = createApp(store);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}
