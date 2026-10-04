import type { Point, VerificationIssue, VerificationResult } from "./types.js";
import { bruteForceMinDistance } from "./sampler.js";

/**
 * 独立验证任意候选点集。
 * 不读取、不信任任何“由本服务生成”的标记：
 *  - 边界：左闭右开 [0,width) × [0,height)
 *  - 重复点：坐标完全相同
 *  - 最小距离：全点对 O(n²) 检查，dist < r 即违规（相等接受）
 * 问题列表按 边界 → 重复 → 过近 分类，最多返回前 100 条。
 */
export function verifyPoints(
  width: number,
  height: number,
  r: number,
  points: Point[],
): VerificationResult {
  const issues: VerificationIssue[] = [];
  const r2 = r * r;

  // 1) 边界
  points.forEach((p, idx) => {
    if (!(p.x >= 0 && p.y >= 0 && p.x < width && p.y < height)) {
      issues.push({ type: "out_of_bounds", idx, x: p.x, y: p.y });
    }
  });

  // 2) 重复点（完全相同坐标）
  const seen = new Map<string, number>();
  points.forEach((p, idx) => {
    const key = `${p.x}|${p.y}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      issues.push({
        type: "duplicate",
        idx,
        x: p.x,
        y: p.y,
        otherIdx: prev,
        otherX: p.x,
        otherY: p.y,
        distance: 0,
      });
    } else {
      seen.set(key, idx);
    }
  });

  // 3) 最小距离（全点对，与采样器网格判定相互独立）
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const d2 = dx * dx + dy * dy;
      if (d2 < r2) {
        issues.push({
          type: "too_close",
          idx: i,
          x: points[i].x,
          y: points[i].y,
          otherIdx: j,
          otherX: points[j].x,
          otherY: points[j].y,
          distance: Math.sqrt(d2),
        });
      }
    }
  }

  const { minDist } = bruteForceMinDistance(points);
  const issueCount = issues.length;

  return {
    passed: issueCount === 0,
    count: points.length,
    minPairDistance: minDist,
    r,
    width,
    height,
    issueCount,
    issues: issues.slice(0, 100),
    note:
      "验证独立执行全点对检查：边界为左闭右开 [0,w)×[0,h)，距离相等（=r）接受，仅 dist<r 判违规；不采信任何来源标记。",
  };
}

export interface NearQueryResult {
  query: Point;
  radius: number;
  neighbors: Array<{ idx: number; x: number; y: number; distance: number }>;
  nearest: { idx: number; x: number; y: number; distance: number } | null;
}

/** 查询某点半径 radius 内的已有点（含最近点）。线性扫描，结果按距离升序。 */
export function queryNear(
  points: Point[],
  query: Point,
  radius: number,
  limit = 500,
): NearQueryResult {
  const all = points.map((p, idx) => {
    const dx = p.x - query.x;
    const dy = p.y - query.y;
    return { idx, x: p.x, y: p.y, distance: Math.sqrt(dx * dx + dy * dy) };
  });
  const within = all
    .filter((n) => n.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
  const nearest = all.length
    ? all.reduce((a, b) => (b.distance < a.distance ? b : a))
    : null;
  return {
    query,
    radius,
    neighbors: within.slice(0, limit),
    nearest,
  };
}
