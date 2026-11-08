import { struct } from "@loopy/core";
import { Schema } from "effect";
import type { Route } from "../api";
import { cloudArtifactQuerySchema, sandboxArtifactSchema } from "./attempt";

const emptySchema = Schema.Record(Schema.String, Schema.Never);

/** The trusted Worker names the authenticated workspace for its workspace Durable Object. */
export const WORKSPACE_HEADER = "X-Loopy-Workspace";

export const cloudStatusSchema = struct({
  stage: Schema.Literal("local"),
  workspace: Schema.String,
  alarm: Schema.NullOr(Schema.Finite),
  errors: Schema.Array(struct({ runId: Schema.String, error: Schema.String })),
  schedules: Schema.Array(
    struct({
      workspace: Schema.String,
      slug: Schema.String,
      error: Schema.String,
      retryAt: Schema.NullOr(Schema.String),
    }),
  ),
  schedulerError: Schema.NullOr(Schema.String),
});

/** Cloud-only routes beside the shared API table. */
export const cloudRoutes = {
  artifact: {
    method: "GET",
    path: "/cloud/artifacts",
    params: emptySchema,
    query: cloudArtifactQuerySchema,
    body: Schema.Undefined,
    response: sandboxArtifactSchema,
  },
  status: {
    method: "GET",
    path: "/cloud/status",
    params: emptySchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: cloudStatusSchema,
  },
} as const satisfies Record<string, Route>;
