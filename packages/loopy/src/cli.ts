#!/usr/bin/env bun
import { runCli } from "@loopy/cli";

if (import.meta.main) {
  await runCli();
}
