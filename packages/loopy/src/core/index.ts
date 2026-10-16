export { parseArgv } from "./argv.js";

export type { CommandDescriptor, FlagDefinition, PositionalDefinition } from "./command-types.js";

export { errorMessage } from "./errors.js";

export type {
  CommandOutput,
  CommandResult,
  EngineLog,
  EngineRun,
  EngineRunDetail,
  EngineRunStatus,
  EngineStep,
  ExecutionMode,
  Json,
  LogLevel,
  LogPosition,
  ResolvedCommand,
  RunOptions,
  RunOutcome,
  RunOwner,
  Schedule,
  StepBase,
  StepKind,
  StepStatus,
  Workspace,
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
