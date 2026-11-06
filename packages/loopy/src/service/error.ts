import { Data } from "effect";
import { DEFAULT_ERROR_MESSAGES, type ErrorCode } from "../contract";

export class ServiceError extends Data.TaggedError("ServiceError")<{
  code: ErrorCode;
  message: string;
}> {
  constructor(code: ErrorCode, message = DEFAULT_ERROR_MESSAGES[code]) {
    super({ code, message });
  }
}
