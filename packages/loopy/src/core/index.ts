export { parseArgv } from "./argv.js";

export type { FlagDefinition, PositionalDefinition } from "./command-types.js";

export { errorMessage } from "./errors.js";

export type {
  CommandOutput,
  CommandResult,
  ExecutionMode,
  Json,
  LogLevel,
  LogPosition,
  LogRecord,
  RunDetail,
  RunOutcome,
  RunOwner,
  RunRecord,
  RunStatus,
  Schedule,
  StepBase,
  StepKind,
  StepRecord,
  StepStatus,
} from "./model.js";

export { isTerminalRun, TERMINAL_RUN_STATUSES } from "./model.js";

export { validateEnvironmentName, validateSecretName, validateSlug } from "./names.js";

export type { UnknownRecord } from "./validation.js";

export {
  allowKeys,
  isBoolean,
  isNumber,
  isRecord,
  isString,
  isStringArray,
  requireBoolean,
  requireNonEmptyString,
  requireOneOf,
  requirePositiveInteger,
  requireRecord,
  requireString,
  setOwnProperty,
} from "./validation.js";
