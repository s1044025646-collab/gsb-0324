import { PRNG_VERSION, createPrng } from "./prng.js";
import type {
  Point,
  RejectEvent,
  SamplerLimits,
  SamplerParams,
  SamplerResult,
  StoredPoint,
} from "./types.js";
import { checkGridBudget } from "./validate.js";

/**
 * 活动点选择规则（公开、固定）：
 *   active list 采用 FIFO 队列；总是取队首（下标 0）活动点，
 *   每接受一个候选点即追加到队尾；某点连续 k 次候选全部失败则移出队首。
 * 同版本同参数（含种子）下，点序列完全一致。
 */
export const ACTIVE_SELECTION_RULE = "fifo_front";

interface GridEntry {
  idx: number;
  x: number;
  y: number;
}

export interface BridsonRun extends SamplerParams {
  limits: SamplerLimits;
}

/**
 * 执行 Bridson 泊松圆盘采样。
 *
 * 辅助网格：边长 cell = r / sqrt(2)，保证每格至多 1 个已接受点，
 * 距离 r 内的点只可能落在 ±2 格邻域内（共 5×5），全部检查。
 *
 * 候选生成：角度 theta = 2*pi*u1（均匀），
 *           半径 rho = r * sqrt(1 + 3*u2)（对圆环面积均匀，覆盖 [r, 2r)）。
 *
 * 距离判定：dist2 < r^2 拒绝；相等（>=）接受。浮点策略见 README“浮点容差”。
 */
export function runBridson(run: BridsonRun): SamplerResult {
  const { width, height, r, k, seed, limits } = run;
  const { cell, gx, gy } = checkGridBudget(width, height, r, limits);

  const r2 = r * r;
  const prng = createPrng(seed);

  const points: StoredPoint[] = [];
  const rejects: RejectEvent[] = [];
  const active: StoredPoint[] = [];

  // 稀疏网格：Map<格编号, 已接受点>；同一格最多一个点。
  const grid = new Map<number, GridEntry>();
  const cellIndex = (x: number, y: number) => {
    let cx = Math.floor(x / cell);
    let cy = Math.floor(y / cell);
    if (cx < 0) cx = 0;
    if (cy < 0) cy = 0;
    if (cx >= gx) cx = gx - 1;
    if (cy >= gy) cy = gy - 1;
    return cy * gx + cx;
  };

  const inBounds = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height;

  /** 检查 5×5 邻域；返回距离过近的点，无则 null。 */
  const findTooClose = (
    x: number,
    y: number,
  ): { entry: GridEntry; dist2: number } | null => {
    const cx = Math.max(0, Math.min(gx - 1, Math.floor(x / cell)));
    const cy = Math.max(0, Math.min(gy - 1, Math.floor(y / cell)));
    for (let oy = -2; oy <= 2; oy++) {
      const ny = cy + oy;
      if (ny < 0 || ny >= gy) continue;
      for (let ox = -2; ox <= 2; ox++) {
        const nx = cx + ox;
        if (nx < 0 || nx >= gx) continue;
        const entry = grid.get(ny * gx + nx);
        if (!entry) continue;
        const dx = x - entry.x;
        const dy = y - entry.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2) return { entry, dist2: d2 };
      }
    }
    return null;
  };

  const addPoint = (
    p: Point,
    kind: "initial" | "candidate",
    acceptedAttempt: number,
  ): StoredPoint => {
    const stored: StoredPoint = {
      idx: points.length,
      x: p.x,
      y: p.y,
      kind,
      acceptedAttempt,
    };
    points.push(stored);
    active.push(stored);
    grid.set(cellIndex(p.x, p.y), { idx: stored.idx, x: p.x, y: p.y });
    return stored;
  };

  // 1) 初始点：[0,width) × [0,height) 内由同一个 PRNG 均匀取两个分量。
  const x0 = prng.next() * width;
  const y0 = prng.next() * height;
  addPoint({ x: x0, y: y0 }, "initial", 0);

  let attempts = 0;
  let status: "completed" | "partial" = "completed";
  let stopReason:
    | "active_list_exhausted"
    | "point_budget"
    | "attempt_budget" = "active_list_exhausted";
  let explanationTruncated = false;

  // 2) 活动列表迭代（FIFO 队首规则）。
  while (active.length > 0) {
    if (points.length >= limits.maxPoints) {
      status = "partial";
      stopReason = "point_budget";
      break;
    }

    const anchor = active[0];
    let found = false;

    for (let t = 0; t < k; t++) {
      if (attempts >= limits.maxAttempts) {
        status = "partial";
        stopReason = "attempt_budget";
        break;
      }
      attempts++;

      const u1 = prng.next();
      const u2 = prng.next();
      const theta = 2 * Math.PI * u1;
      const rho = r * Math.sqrt(1 + 3 * u2); // 对圆环面积均匀
      const cx = anchor.x + rho * Math.cos(theta);
      const cy = anchor.y + rho * Math.sin(theta);

      if (!inBounds(cx, cy)) {
        if (rejects.length < limits.maxExplanations) {
          rejects.push({
            attempt: attempts,
            activeIdx: anchor.idx,
            x: cx,
            y: cy,
            reason: "out_of_bounds",
          });
        } else {
          explanationTruncated = true;
        }
        continue;
      }

      const clash = findTooClose(cx, cy);
      if (clash) {
        if (rejects.length < limits.maxExplanations) {
          rejects.push({
            attempt: attempts,
            activeIdx: anchor.idx,
            x: cx,
            y: cy,
            reason: "too_close",
            nearIdx: clash.entry.idx,
            nearX: clash.entry.x,
            nearY: clash.entry.y,
            dist2: clash.dist2,
          });
        } else {
          explanationTruncated = true;
        }
        continue;
      }

      if (points.length >= limits.maxPoints) {
            status = "partial";
            stopReason = "point_budget";
            break;
      }
      addPoint({ x: cx, y: cy }, "candidate", attempts);
      found = true;
      break; // 重新从队首活动点开始（队首未变，继续尝试同一锚点）
    }

    if (status === "partial") break;
    if (!found) active.shift(); // k 次均失败，移除活动点
  }

  return {
    points,
    rejects,
    status,
    stopReason,
    attempts,
    activeRemaining: active.length,
    gridCellsX: gx,
    gridCellsY: gy,
    explanationTruncated,
    prngVersion: PRNG_VERSION,
    activeSelectionRule: ACTIVE_SELECTION_RULE,
  };
}

/** 独立全点对核验（O(n²)），供小结果交叉验证网格判定与验证接口。 */
export function bruteForceMinDistance(points: Point[]): {
  minDist: number | null;
  pair: [number, number] | null;
} {
  let minDist: number | null = null;
  let pair: [number, number] | null = null;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (minDist === null || d < minDist) {
        minDist = d;
        pair = [i, j];
      }
    }
  }
  return { minDist, pair };
}
