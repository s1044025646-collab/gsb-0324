export interface Point {
  x: number;
  y: number;
}

export interface StoredPoint extends Point {
  idx: number;
  /** "initial" = 初始点；"candidate" = 候选接受点 */
  kind: "initial" | "candidate";
  /** 该点在整个生成过程中是第几次候选尝试接受的（初始点为 0） */
  acceptedAttempt: number;
}

export interface RejectEvent {
  /** 全局候选尝试序号（从 1 开始） */
  attempt: number;
  /** 产生该候选时选中的活动点序号 */
  activeIdx: number;
  x: number;
  y: number;
  reason: "out_of_bounds" | "too_close";
  /** reason=too_close 时，距离过近的已接受点序号与平方距离 */
  nearIdx?: number;
  nearX?: number;
  nearY?: number;
  dist2?: number;
}

export type RunStatus = "completed" | "partial";
export type StopReason =
  | "active_list_exhausted"
  | "point_budget"
  | "attempt_budget";

export interface SamplerParams {
  width: number;
  height: number;
  /** 最小点距 r（严格正数，欧氏距离） */
  r: number;
  /** 每个活动点的候选尝试次数 k */
  k: number;
  /** 字符串随机种子 */
  seed: string;
}

export interface SamplerLimits {
  /** 辅助网格允许的最大格数（cellX * cellY），超过直接报参数错误 */
  maxGridCells: number;
  maxPoints: number;
  maxAttempts: number;
  /** 持久化解释明细（拒绝记录）的最大条数，截短不影响采样本身 */
  maxExplanations: number;
}

export interface SamplerResult {
  points: StoredPoint[];
  rejects: RejectEvent[];
  status: RunStatus;
  stopReason: StopReason;
  attempts: number;
  /** 活动列表剩余长度（预算截断时可能非 0） */
  activeRemaining: number;
  gridCellsX: number;
  gridCellsY: number;
  explanationTruncated: boolean;
  prngVersion: string;
  activeSelectionRule: string;
}

export interface VerificationIssue {
  type: "out_of_bounds" | "duplicate" | "too_close";
  idx: number;
  x?: number;
  y?: number;
  otherIdx?: number;
  otherX?: number;
  otherY?: number;
  distance?: number;
}

export interface VerificationResult {
  passed: boolean;
  count: number;
  minPairDistance: number | null;
  r: number;
  width: number;
  height: number;
  issueCount: number;
  issues: VerificationIssue[];
  note: string;
}
