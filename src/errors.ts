export type ErrorCode =
  | "VALIDATION_ERROR"
  | "GRID_LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "INVALID_JSON"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
