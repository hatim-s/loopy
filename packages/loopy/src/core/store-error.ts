import { OUTPUT_LIMIT_MESSAGE } from "./effects.js";

export const STORE_ERROR_CODES = [
  "not_found",
  "already_exists",
  "owned_elsewhere",
  "not_claimable",
  "not_running",
  "wrong_run",
  "output_limit",
  "log_limit",
  "invalid_log_position",
  "schedule_not_found",
  "missing_epoch",
  "write_failed",
] as const;

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

const STORE_ERROR_MESSAGES = {
  not_found: "Run does not exist. Create the run first.",
  already_exists: "Run already exists. Use a new run ID.",
  owned_elsewhere: "Run is not owned by this token. Claim the run before writing.",
  not_claimable: "Run cannot be claimed in its current status. Activate a queued or suspended run.",
  not_running: "Run must be running before applying writes.",
  wrong_run: "Write belongs to another run.",
  output_limit: OUTPUT_LIMIT_MESSAGE,
  log_limit: "Attempt logs exceed the 64 KiB limit.",
  invalid_log_position: "Attempt logs require a node execution key.",
  schedule_not_found: "Schedule does not exist. Save the schedule first.",
  missing_epoch: "Store epoch is missing. Recreate the database.",
  write_failed: "Store write did not complete. Restore storage.",
} as const satisfies Record<StoreErrorCode, string>;

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(STORE_ERROR_MESSAGES[code]);
    this.name = "StoreError";
  }
}
