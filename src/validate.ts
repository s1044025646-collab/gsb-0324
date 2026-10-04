import { EPS_REL, ParamError, Pt } from "./sampler";

export interface ValidationIssue {
  code: "OUT_OF_BOUNDS" | "DUPLICATE" | "TOO_CLOSE";
  i: number;
  j?: number;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  pointCount: number;
  minDistance: number | null;
  issues: ValidationIssue[];
  truncated: boolean;
}

const MAX_ISSUES = 1000;

// 独立校验：全点对 O(n^2) 距离检查，不依赖采样网格，也不信任任何来源标记。
export function validatePointSet(
  width: number,
  height: number,
  r: number,
  points: Pt[]
): ValidationResult {
  if (!Number.isFinite(width) || width <= 0) throw new ParamError("INVALID_WIDTH", "width 必须为正的有限数");
  if (!Number.isFinite(height) || height <= 0) throw new ParamError("INVALID_HEIGHT", "height 必须为正的有限数");
  if (!Number.isFinite(r) || r <= 0) throw new ParamError("INVALID_R", "r 必须为正的有限数");
  if (!Array.isArray(points)) throw new ParamError("INVALID_POINTS", "points 必须为数组");

  const issues: ValidationIssue[] = [];
  let truncated = false;
  const push = (issue: ValidationIssue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
    else truncated = true;
  };

  const r2 = r * r;
  const eps = EPS_REL * r2;
  let minD2 = Infinity;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      push({ code: "OUT_OF_BOUNDS", i, detail: `点 ${i} 坐标非法` });
      continue;
    }
    // 左闭右开矩形
    if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) {
      push({ code: "OUT_OF_BOUNDS", i, detail: `点 ${i} (${p.x},${p.y}) 超出 [0,${width})x[0,${height})` });
    }
  }

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) minD2 = d2;
      if (d2 === 0) {
        push({ code: "DUPLICATE", i, j, detail: `点 ${i} 与点 ${j} 完全重合` });
      } else if (d2 < r2 - eps) {
        push({
          code: "TOO_CLOSE", i, j,
          detail: `点 ${i} 与点 ${j} 距离 ${Math.sqrt(d2)} < r=${r}`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0 && !truncated,
    pointCount: points.length,
    minDistance: points.length >= 2 && minD2 !== Infinity ? Math.sqrt(minD2) : null,
    issues,
    truncated,
  };
}
