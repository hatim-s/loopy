import { DEFAULT_ERROR_MESSAGES, type ErrorCode } from "@loopy/contract";
import { Data } from "effect";

export class ServiceError extends Data.TaggedError("ServiceError")<{
  code: ErrorCode;
  message: string;
}> {
  constructor(code: ErrorCode, message = DEFAULT_ERROR_MESSAGES[code]) {
    super({ code, message });
  }
}
