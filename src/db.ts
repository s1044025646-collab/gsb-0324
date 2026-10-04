import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  RejectEvent,
  SamplerLimits,
  SamplerParams,
  SamplerResult,
  VerificationResult,
} from "./types.js";

export interface RunRecord {
  id: number;
  width: number;
  height: number;
  r: number;
  k: number;
  seed: string;
  prngVersion: string;
  activeSelectionRule: string;
  status: string;
  stopReason: string;
  attempts: number;
  activeRemaining: number;
  gridCellsX: number;
  gridCellsY: number;
  pointCount: number;
  explanationTruncated: number;
  maxGridCells: number;
  maxPoints: number;
  maxAttempts: number;
  maxExplanations: number;
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        width REAL NOT NULL,
        height REAL NOT NULL,
        r REAL NOT NULL,
        k INTEGER NOT NULL,
        seed TEXT NOT NULL,
        prng_version TEXT NOT NULL,
        active_selection_rule TEXT NOT NULL,
        status TEXT NOT NULL,
        stop_reason TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        active_remaining INTEGER NOT NULL,
        grid_cells_x INTEGER NOT NULL,
        grid_cells_y INTEGER NOT NULL,
        point_count INTEGER NOT NULL,
        explanation_truncated INTEGER NOT NULL,
        max_grid_cells INTEGER NOT NULL,
        max_points INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        max_explanations INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS points (
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        kind TEXT NOT NULL,
        accepted_attempt INTEGER NOT NULL,
        PRIMARY KEY (run_id, idx)
      );
      CREATE TABLE IF NOT EXISTS rejects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        active_idx INTEGER NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        reason TEXT NOT NULL,
        near_idx INTEGER,
        near_x REAL,
        near_y REAL,
        dist2 REAL
      );
      CREATE TABLE IF NOT EXISTS verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        r REAL NOT NULL,
        passed INTEGER NOT NULL,
        point_count INTEGER NOT NULL,
        min_pair_distance REAL,
        issue_count INTEGER NOT NULL,
        issues_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * 持久化一次采样结果。
   * 注意：只在采样正常结束（含 partial）后调用；采样抛错时不会触碰数据库，
   * 已有成功点集不会被失败覆盖。
   */
  saveRun(params: SamplerParams, limits: SamplerLimits, result: SamplerResult): number {
    const insertRun = this.db.prepare(`
      INSERT INTO runs (width, height, r, k, seed, prng_version, active_selection_rule,
        status, stop_reason, attempts, active_remaining, grid_cells_x, grid_cells_y,
        point_count, explanation_truncated, max_grid_cells, max_points, max_attempts,
        max_explanations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPoint = this.db.prepare(
      `INSERT INTO points (run_id, idx, x, y, kind, accepted_attempt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertReject = this.db.prepare(
      `INSERT INTO rejects (run_id, attempt, active_idx, x, y, reason, near_idx, near_x, near_y, dist2)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const info = insertRun.run(
        params.width,
        params.height,
        params.r,
        params.k,
        params.seed,
        result.prngVersion,
        result.activeSelectionRule,
        result.status,
        result.stopReason,
        result.attempts,
        result.activeRemaining,
        result.gridCellsX,
        result.gridCellsY,
        result.points.length,
        result.explanationTruncated ? 1 : 0,
        limits.maxGridCells,
        limits.maxPoints,
        limits.maxAttempts,
        limits.maxExplanations,
      );
      const id = Number(info.lastInsertRowid);
      for (const p of result.points) {
        insertPoint.run(id, p.idx, p.x, p.y, p.kind, p.acceptedAttempt);
      }
      for (const rej of result.rejects) {
        insertReject.run(
          id,
          rej.attempt,
          rej.activeIdx,
          rej.x,
          rej.y,
          rej.reason,
          rej.nearIdx ?? null,
          rej.nearX ?? null,
          rej.nearY ?? null,
          rej.dist2 ?? null,
        );
      }
      this.db.exec("COMMIT");
      return id;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getRun(id: number): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : null;
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRun(r));
  }

  private mapRun(row: Record<string, unknown>): RunRecord {
    return {
      id: Number(row.id),
      width: Number(row.width),
      height: Number(row.height),
      r: Number(row.r),
      k: Number(row.k),
      seed: String(row.seed),
      prngVersion: String(row.prng_version),
      activeSelectionRule: String(row.active_selection_rule),
      status: String(row.status),
      stopReason: String(row.stop_reason),
      attempts: Number(row.attempts),
      activeRemaining: Number(row.active_remaining),
      gridCellsX: Number(row.grid_cells_x),
      gridCellsY: Number(row.grid_cells_y),
      pointCount: Number(row.point_count),
      explanationTruncated: Number(row.explanation_truncated),
      maxGridCells: Number(row.max_grid_cells),
      maxPoints: Number(row.max_points),
      maxAttempts: Number(row.max_attempts),
      maxExplanations: Number(row.max_explanations),
      createdAt: String(row.created_at),
    };
  }

  getPoints(id: number): import("./types.js").StoredPoint[] {
    const rows = this.db
      .prepare(
        "SELECT idx, x, y, kind, accepted_attempt FROM points WHERE run_id = ? ORDER BY idx",
      )
      .all(id) as Record<string, unknown>[];
    return rows.map((row) => ({
      idx: Number(row.idx),
      x: Number(row.x),
      y: Number(row.y),
      kind: String(row.kind) as "initial" | "candidate",
      acceptedAttempt: Number(row.accepted_attempt),
    }));
  }

  getRejects(id: number): RejectEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM rejects WHERE run_id = ? ORDER BY attempt, id")
      .all(id) as Record<string, unknown>[];
    return rows.map((row) => ({
      attempt: Number(row.attempt),
      activeIdx: Number(row.active_idx),
      x: Number(row.x),
      y: Number(row.y),
      reason: String(row.reason) as RejectEvent["reason"],
      nearIdx: row.near_idx === null ? undefined : Number(row.near_idx),
      nearX: row.near_x === null ? undefined : Number(row.near_x),
      nearY: row.near_y === null ? undefined : Number(row.near_y),
      dist2: row.dist2 === null ? undefined : Number(row.dist2),
    }));
  }

  /** 拒绝原因汇总 */
  rejectSummary(id: number): {
    totalStored: number;
    outOfBounds: number;
    tooClose: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT reason, COUNT(*) AS c FROM rejects WHERE run_id = ? GROUP BY reason`,
      )
      .all(id) as { reason: string; c: number }[];
    let outOfBounds = 0;
    let tooClose = 0;
    for (const row of rows) {
      if (row.reason === "out_of_bounds") outOfBounds = Number(row.c);
      else if (row.reason === "too_close") tooClose = Number(row.c);
    }
    return { totalStored: outOfBounds + tooClose, outOfBounds, tooClose };
  }

  saveVerification(
    runId: number | null,
    width: number,
    height: number,
    r: number,
    result: VerificationResult,
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO verifications (run_id, width, height, r, passed, point_count,
           min_pair_distance, issue_count, issues_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        width,
        height,
        r,
        result.passed ? 1 : 0,
        result.count,
        result.minPairDistance ?? null,
        result.issueCount,
        JSON.stringify(result.issues),
      );
    return Number(info.lastInsertRowid);
  }
}
