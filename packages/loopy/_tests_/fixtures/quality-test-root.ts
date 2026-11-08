import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Scope } from "effect";
import { fixtureScope, onCleanup } from "./test-scope";

const CHECKOUT = resolve(import.meta.dir, "../../../..", ".loopy/quality-tests");

interface RootOptions {
  /** Owns the removal. Pass fileScope() when allocating in beforeAll. */
  readonly scope?: Scope.Scope;
  /**
   * Sandboxed bun reads tsconfig.json in every ancestor of a bundle, and the sandbox denies the
   * checkout's, so tests that assert exact bundle stderr allocate under the system temp root.
   */
  readonly outsideCheckout?: boolean;
}

/**
 * Allocates a unique directory with its own registry marker, so registry lookup stops before
 * ancestor projects. State stays inside this checkout unless the caller opts out.
 */
export function qualityTestRoot(prefix: string, options: RootOptions = {}) {
  const parent = options.outsideCheckout ? tmpdir() : CHECKOUT;
  mkdirSync(parent, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(parent, `loopy-${prefix}-`)));
  mkdirSync(join(directory, ".loopy/loopies"), { recursive: true });

  onCleanup(
    () => rmSync(directory, { recursive: true, force: true }),
    options.scope ?? fixtureScope(),
  );

  return directory;
}
