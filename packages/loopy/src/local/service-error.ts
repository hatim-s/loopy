import { DEFAULT_ERROR_MESSAGES, type ErrorCode } from "../contract/index.js";

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message = DEFAULT_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
