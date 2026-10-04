import type { RejectEvent, StoredPoint } from "./types.js";
import type { RunRecord } from "./db.js";

export interface RunDetail {
  run: RunRecord;
  points?: StoredPoint[];
  rejectSummary?: {
    totalStored: number;
    outOfBounds: number;
    tooClose: number;
  };
  rejects?: RejectEvent[];
}

export function toJSON(detail: RunDetail): string {
  return JSON.stringify(detail, null, 2);
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function pointsToCSV(points: StoredPoint[]): string {
  const header = "idx,x,y,kind,accepted_attempt";
  const body = points
    .map((p) =>
      [p.idx, p.x, p.y, p.kind, p.acceptedAttempt].map(csvEscape).join(","),
    )
    .join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

export function rejectsToCSV(rejects: RejectEvent[]): string {
  const header =
    "attempt,active_idx,x,y,reason,near_idx,near_x,near_y,dist2";
  const body = rejects
    .map((rej) =>
      [
        rej.attempt,
        rej.activeIdx,
        rej.x,
        rej.y,
        rej.reason,
        rej.nearIdx ?? "",
        rej.nearX ?? "",
        rej.nearY ?? "",
        rej.dist2 ?? "",
      ]
        .map(csvEscape)
        .join(","),
    )
    .join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}
