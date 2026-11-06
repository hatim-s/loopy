import { definitionInput, definitionSummarySchema, type PutLoopyBody } from "@loopy/contract";
import { ARTIFACT_LIMITS } from "./storage";

export const definitionProjectionSchema = definitionSummarySchema.mapFields((fields) => ({
  scope: fields.scope,
  description: fields.description,
  input: fields.input,
  schedule: fields.schedule,
  mode: fields.mode,
}));

type DefinitionProjection = typeof definitionProjectionSchema.Type;

const encoder = new TextEncoder();

export function projectionJson(summary: DefinitionProjection): string {
  const { scope, description, input, schedule, mode } = summary;

  return JSON.stringify({
    scope,
    description,
    input,
    schedule,
    mode,
  } satisfies DefinitionProjection);
}

function rowBytes(fields: string[]): number {
  return fields.reduce((total, field) => total + encoder.encode(field).byteLength, 0);
}

export function checkProjectionRow(row: {
  workspace: string;
  slug: string;
  generation: string;
  projection: string;
}): void {
  const { workspace, slug, generation, projection } = row;

  if (rowBytes([workspace, slug, generation, projection]) > ARTIFACT_LIMITS.metadataRowBytes) {
    throw new Error(
      "Definition projection exceeds the cloud SQL row byte budget. Reduce its description, input or schedule before saving.",
    );
  }
}

export function checkDefinitionRows(body: PutLoopyBody): void {
  // UUIDs use 36 ASCII bytes; even an extended-year ISO timestamp uses at most 27.
  const pointerBytes =
    rowBytes([body.source.workspace, body.graph.name, body.revision, body.source.path]) + 36 + 27;

  if (pointerBytes > ARTIFACT_LIMITS.metadataRowBytes) {
    throw new Error(
      "Definition source metadata exceeds the cloud SQL row byte budget. Shorten its source path before saving.",
    );
  }

  checkProjectionRow({
    workspace: body.source.workspace,
    slug: body.graph.name,
    generation: "0".repeat(36),
    projection: projectionJson({
      ...body.graph.meta,
      input: definitionInput(body.graph),
    }),
  });
}
