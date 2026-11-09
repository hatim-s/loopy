import { resolve } from "node:path";
import { compile } from "@loopy/compiler";
import type { PutLoopyBody } from "@loopy/contract";
import { Effect } from "effect";
import { root } from "../stack/constants";
import { assert } from "./assert";

export function compileFixture(name: string) {
  return Effect.gen(function* () {
    const path = resolve(root, "apps/cloud/dev/fixtures/cloud", name);
    const result = yield* compile(path);
    assert(result.ok, "fixture_compile_failed", {
      fixture: name,
      diagnostics: result.ok
        ? []
        : result.diagnostics.map((value) => `${value.code}:${value.line}:${value.column}`),
    });

    const body: PutLoopyBody = {
      graph: result.graph,
      revision: result.revision,
      sourceArtifact: result.sourceArtifact,
      bundles: result.bundles,
      source: { path, workspace: "fixtures" },
      replace: true,
    };

    return body;
  });
}
