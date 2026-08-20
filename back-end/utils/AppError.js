// utils/AppError.js - Typed application error.
//
// Every failure that has a known cause is thrown as an AppError carrying a
// machine-readable `code` and the HTTP status it should produce. The error
// handler can then map failures deterministically instead of pattern-matching
// on English error text.
export class AppError extends Error {
  constructor(message, { code = "INTERNAL_ERROR", statusCode = 500, details } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

export default AppError;
