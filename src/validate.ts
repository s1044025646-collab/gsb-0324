import { ApiError } from "./errors.js";
import type { Point, SamplerLimits, SamplerParams } from "./types.js";

export const DEFAULT_LIMITS: SamplerLimits = {
  maxGridCells: 2_000_000,
  maxPoints: 50_000,
  maxAttempts: 2_000_000,
  maxExplanations: 2_000,
};

/** 有限正实数 */
function isFinitePositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * 校验生成参数。
 * 边界语义：矩形 [0,width) × [0,height)，左闭右开，无周期边界。
 */
export function validateParams(input: any): SamplerParams {
  const errors: string[] = [];
  if (input === null || typeof input !== "object") {
    throw new ApiError("VALIDATION_ERROR", "请求体必须是 JSON 对象", 400);
  }
  const { width, height, r, k, seed } = input;

  if (!isFinitePositive(width) || width > 1e9) {
    errors.push("width 必须是 (0, 1e9] 范围内的有限正数");
  }
  if (!isFinitePositive(height) || height > 1e9) {
    errors.push("height 必须是 (0, 1e9] 范围内的有限正数");
  }
  if (!isFinitePositive(r) || r > 1e9) {
    errors.push("r 必须是 (0, 1e9] 范围内的有限正数");
  }
  if (
    !Number.isInteger(k) ||
    (k as number) < 1 ||
    (k as number) > 100000
  ) {
    errors.push("k 必须是 [1, 100000] 范围内的整数");
  }
  if (typeof seed !== "string" || seed.length === 0 || seed.length > 200) {
    errors.push("seed 必须是非空字符串（长度不超过 200）");
  }

  if (
    errors.length === 0 &&
    (isFinitePositive(width) === false ||
      isFinitePositive(height) === false ||
      isFinitePositive(r) === false)
  ) {
    errors.push("width、height、r 必须是有限数");
  }

  if (errors.length > 0) {
    throw new ApiError("VALIDATION_ERROR", "参数校验失败", 422, errors);
  }
  return { width, height, r, k, seed };
}

export function validateLimits(input: any): SamplerLimits {
  const limits = { ...DEFAULT_LIMITS };
  if (input?.limits && typeof input.limits === "object") {
    const map: Record<keyof SamplerLimits, string> = {
      maxGridCells: "maxGridCells",
      maxPoints: "maxPoints",
      maxAttempts: "maxAttempts",
      maxExplanations: "maxExplanations",
    };
    const errors: string[] = [];
    for (const key of Object.keys(map) as (keyof SamplerLimits)[]) {
      const v = input.limits[key];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 1 || v > 100_000_000) {
        errors.push(`${map[key]} 必须是 [1, 1e8] 的整数`);
      } else {
        limits[key] = v;
      }
    }
    if (errors.length > 0) {
      throw new ApiError("VALIDATION_ERROR", "预算参数非法", 422, errors);
    }
  }
  return limits;
}

/**
 * 检查辅助网格规模预算。
 * 网格边长 cell = r / sqrt(2)；即使 r 大于矩形边长，至少保留 1 列/行。
 */
export function checkGridBudget(
  width: number,
  height: number,
  r: number,
  limits: SamplerLimits,
): { cell: number; gx: number; gy: number } {
  const cell = r / Math.SQRT2;
  const gx = Math.max(1, Math.ceil(width / cell));
  const gy = Math.max(1, Math.ceil(height / cell));
  const total = gx * gy;
  if (!Number.isFinite(total) || total > limits.maxGridCells) {
    throw new ApiError(
      "GRID_LIMIT_EXCEEDED",
      `辅助网格规模 ${total} 超过预算 maxGridCells=${limits.maxGridCells}；请增大 r 或减小矩形尺寸`,
      422,
      { gridCells: Number.isFinite(total) ? total : null, maxGridCells: limits.maxGridCells },
    );
  }
  return { cell, gx, gy };
}

/** 校验任意候选点集（供验证接口使用）。返回规范化后的点数组。 */
export function validateCandidatePoints(input: any): { points: Point[]; r: number } {
  if (input === null || typeof input !== "object") {
    throw new ApiError("VALIDATION_ERROR", "请求体必须是 JSON 对象", 400);
  }
  const { width, height, r, points } = input;
  const errors: string[] = [];
  if (!isFinitePositive(width) || width > 1e9) {
    errors.push("width 必须是 (0, 1e9] 的有限正数");
  }
  if (!isFinitePositive(height) || height > 1e9) {
    errors.push("height 必须是 (0, 1e9] 的有限正数");
  }
  if (!isFinitePositive(r) || r > 1e9) {
    errors.push("r 必须是 (0, 1e9] 的有限正数");
  }
  if (!Array.isArray(points)) {
    errors.push("points 必须是数组");
  } else if (points.length > 200_000) {
    errors.push("points 数量不能超过 200000");
  } else {
    points.forEach((p: any, i: number) => {
      if (
        p === null ||
        typeof p !== "object" ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y)
      ) {
        errors.push(`points[${i}] 必须是包含有限数 x、y 的对象`);
      }
    });
  }
  if (errors.length > 0) {
    throw new ApiError("VALIDATION_ERROR", "验证请求参数非法", 422, errors);
  }
  return { points: points.map((p: any) => ({ x: p.x, y: p.y })), r };
}
