import { createRng, RNG_VERSION } from "./rng";

// 活动点选择规则：后进先出（每次取活动列表末尾）。
export const SELECT_RULE = "lifo-v1";

// 浮点容差策略：
// 距离平方与 r^2 比较时使用相对容差 EPS = 1e-9 * r^2。
// distSq < r^2 - eps 判为过近拒绝；否则（含恰好等于边界）接受。
// 容差仅用于吸收浮点舍入，量级为 1e-9 相对值，不会掩盖真实过近点。
export const EPS_REL = 1e-9;

// 候选半径：圆环 [r, 2r) 面积均匀取样，u ∈ [0, 1)
export function annulusRadius(r: number, u: number): number {
  return r * Math.sqrt(1 + 3 * u);
}

export interface SampleParams {
  width: number;
  height: number;
  r: number;
  k: number;
  seed: number;
  maxPoints?: number;    // 点数预算
  maxAttempts?: number;  // 总尝试次数预算（含初始点）
  maxGridCells?: number; // 网格规模预算
  maxExplain?: number;   // 解释明细条数上限
}

export interface Pt {
  x: number;
  y: number;
}

export interface ExplainEvent {
  kind: "initial" | "accepted" | "reject_out_of_bounds" | "reject_too_close";
  x: number;
  y: number;
  detail?: string;
}

export interface SampleSummary {
  attempts: number;
  accepted: number;
  rejected: number;
  rejectOutOfBounds: number;
  rejectTooClose: number;
  explainTruncated: boolean;
}

export interface SampleResult {
  points: Pt[];
  status: "complete" | "partial";
  reason: string;
  summary: SampleSummary;
  events: ExplainEvent[];
  rngVersion: string;
  selectRule: string;
}

export class ParamError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function validateParams(p: SampleParams): Required<SampleParams> {
  const { width, height, r, k, seed } = p;
  if (!Number.isFinite(width) || width <= 0) throw new ParamError("INVALID_WIDTH", "width 必须为正的有限数");
  if (!Number.isFinite(height) || height <= 0) throw new ParamError("INVALID_HEIGHT", "height 必须为正的有限数");
  if (!Number.isFinite(r) || r <= 0) throw new ParamError("INVALID_R", "r 必须为正的有限数");
  if (!Number.isInteger(k) || k < 1) throw new ParamError("INVALID_K", "k 必须为 >=1 的整数");
  if (!Number.isInteger(seed)) throw new ParamError("INVALID_SEED", "seed 必须为整数");
  const maxPoints = p.maxPoints ?? 1_000_000;
  const maxAttempts = p.maxAttempts ?? 10_000_000;
  const maxGridCells = p.maxGridCells ?? 4_000_000;
  const maxExplain = p.maxExplain ?? 10_000;
  for (const [name, v] of Object.entries({ maxPoints, maxAttempts, maxGridCells, maxExplain })) {
    if (!Number.isInteger(v) || v < 0) throw new ParamError("INVALID_BUDGET", `${name} 必须为 >=0 的整数`);
  }
  return { width, height, r, k, seed, maxPoints, maxAttempts, maxGridCells, maxExplain };
}

export function sample(rawParams: SampleParams): SampleResult {
  const p = validateParams(rawParams);
  const { width, height, r, k } = p;
  const rng = createRng(p.seed);

  const cell = r / Math.SQRT2;
  const gridW = Math.max(1, Math.ceil(width / cell));
  const gridH = Math.max(1, Math.ceil(height / cell));
  const totalCells = gridW * gridH;
  if (totalCells > p.maxGridCells) {
    throw new ParamError("GRID_BUDGET_EXCEEDED", `网格规模 ${totalCells} 超过预算 ${p.maxGridCells}`);
  }

  const grid: Int32Array = new Int32Array(totalCells).fill(-1);
  const points: Pt[] = [];
  const active: number[] = [];
  const events: ExplainEvent[] = [];
  let explainOverflow = 0;

  const summary: SampleSummary = {
    attempts: 0, accepted: 0, rejected: 0,
    rejectOutOfBounds: 0, rejectTooClose: 0, explainTruncated: false,
  };

  const pushEvent = (e: ExplainEvent) => {
    if (events.length < p.maxExplain) events.push(e);
    else explainOverflow++;
  };

  const cellOf = (x: number, y: number): number => {
    const cx = Math.min(gridW - 1, Math.floor(x / cell));
    const cy = Math.min(gridH - 1, Math.floor(y / cell));
    return cy * gridW + cx;
  };

  // 检查 (x,y) 与已接受点的最小距离，覆盖距离 r 的全部相关网格邻居（5x5 邻域）
  const r2 = r * r;
  const eps = EPS_REL * r2;
  const fits = (x: number, y: number): boolean => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
        const idx = grid[ny * gridW + nx];
        if (idx < 0) continue;
        const ddx = points[idx].x - x;
        const ddy = points[idx].y - y;
        if (ddx * ddx + ddy * ddy < r2 - eps) return false;
      }
    }
    return true;
  };

  const accept = (x: number, y: number, kind: "initial" | "accepted") => {
    const idx = points.length;
    points.push({ x, y });
    active.push(idx);
    grid[cellOf(x, y)] = idx;
    summary.accepted++;
    pushEvent({ kind, x, y });
  };

  let status: "complete" | "partial" = "complete";
  let reason = "活动列表耗尽，算法本次正常结束（不宣称最大点数或最优覆盖）";

  // 初始点：同一 RNG，矩形内均匀（左闭右开）
  const x0 = rng() * width;
  const y0 = rng() * height;
  summary.attempts++;
  accept(x0, y0, "initial");

  main: while (active.length > 0) {
    if (points.length >= p.maxPoints) {
      status = "partial";
      reason = `达到点数预算 maxPoints=${p.maxPoints}，部分生成`;
      break;
    }
    if (summary.attempts >= p.maxAttempts) {
      status = "partial";
      reason = `达到总尝试预算 maxAttempts=${p.maxAttempts}，部分生成`;
      break;
    }
    // 固定规则：取活动列表末尾（lifo-v1）
    const idx = active[active.length - 1];
    const base = points[idx];
    let placed = false;
    for (let i = 0; i < k; i++) {
      if (summary.attempts >= p.maxAttempts) {
        status = "partial";
        reason = `达到总尝试预算 maxAttempts=${p.maxAttempts}，部分生成`;
        break main;
      }
      summary.attempts++;
      const angle = rng() * 2 * Math.PI;
      const radius = annulusRadius(r, rng()); // 圆环面积均匀
      const x = base.x + radius * Math.cos(angle);
      const y = base.y + radius * Math.sin(angle);
      if (x < 0 || x >= width || y < 0 || y >= height) {
        summary.rejected++;
        summary.rejectOutOfBounds++;
        pushEvent({ kind: "reject_out_of_bounds", x, y, detail: `base=${idx}` });
        continue;
      }
      if (!fits(x, y)) {
        summary.rejected++;
        summary.rejectTooClose++;
        pushEvent({ kind: "reject_too_close", x, y, detail: `base=${idx}` });
        continue;
      }
      accept(x, y, "accepted");
      placed = true;
      break;
    }
    if (!placed) active.pop(); // k 次尝试仍无候选，移除该活动点
  }

  if (explainOverflow > 0) summary.explainTruncated = true;

  return {
    points, status, reason, summary, events,
    rngVersion: RNG_VERSION,
    selectRule: SELECT_RULE,
  };
}
