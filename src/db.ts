import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExplainEvent, Pt, SampleParams, SampleResult } from "./sampler";

export const DATA_DIR = process.env.POISSON_DATA_DIR
  ? path.resolve(process.env.POISSON_DATA_DIR)
  : path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "poisson.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      width REAL NOT NULL, height REAL NOT NULL, r REAL NOT NULL,
      k INTEGER NOT NULL, seed INTEGER NOT NULL,
      rng_version TEXT NOT NULL, select_rule TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT NOT NULL,
      budgets TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS points (
      run_id INTEGER NOT NULL, idx INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      PRIMARY KEY (run_id, idx)
    );
    CREATE TABLE IF NOT EXISTS events (
      run_id INTEGER NOT NULL, idx INTEGER NOT NULL,
      kind TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      run_id INTEGER,
      ok INTEGER NOT NULL,
      result TEXT NOT NULL
    );
  `);
  return db;
}

export function saveRun(params: SampleParams, result: SampleResult): number {
  const d = getDb();
  const budgets = JSON.stringify({
    maxPoints: params.maxPoints, maxAttempts: params.maxAttempts,
    maxGridCells: params.maxGridCells, maxExplain: params.maxExplain,
  });
  const info = d.prepare(
    `INSERT INTO runs (created_at,width,height,r,k,seed,rng_version,select_rule,status,reason,budgets,summary)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    new Date().toISOString(), params.width, params.height, params.r, params.k, params.seed,
    result.rngVersion, result.selectRule, result.status, result.reason,
    budgets, JSON.stringify(result.summary)
  );
  const runId = Number(info.lastInsertRowid);
  const insP = d.prepare("INSERT INTO points (run_id,idx,x,y) VALUES (?,?,?,?)");
  result.points.forEach((p, i) => insP.run(runId, i, p.x, p.y));
  const insE = d.prepare("INSERT INTO events (run_id,idx,kind,x,y,detail) VALUES (?,?,?,?,?,?)");
  result.events.forEach((e, i) => insE.run(runId, i, e.kind, e.x, e.y, e.detail ?? null));
  return runId;
}

export interface RunRow {
  id: number; created_at: string; width: number; height: number; r: number;
  k: number; seed: number; rng_version: string; select_rule: string;
  status: string; reason: string; budgets: string; summary: string;
}

export function getRun(id: number): RunRow | null {
  const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id);
  return (row as unknown as RunRow) ?? null;
}

export function listRuns(): RunRow[] {
  return getDb().prepare("SELECT * FROM runs ORDER BY id DESC").all() as unknown as RunRow[];
}

export function getPoints(runId: number): Pt[] {
  const rows = getDb().prepare("SELECT x, y FROM points WHERE run_id = ? ORDER BY idx").all(runId) as unknown as Pt[];
  return rows.map((p) => ({ x: p.x, y: p.y }));
}

export function getEvents(runId: number): ExplainEvent[] {
  const rows = getDb().prepare("SELECT kind, x, y, detail FROM events WHERE run_id = ? ORDER BY idx").all(runId) as unknown as ExplainEvent[];
  return rows.map((e) => ({ kind: e.kind, x: e.x, y: e.y, detail: e.detail ?? undefined }));
}

export function saveValidation(runId: number | null, result: object, ok: boolean): number {
  const info = getDb().prepare(
    "INSERT INTO validations (created_at, run_id, ok, result) VALUES (?,?,?,?)"
  ).run(new Date().toISOString(), runId, ok ? 1 : 0, JSON.stringify(result));
  return Number(info.lastInsertRowid);
}
