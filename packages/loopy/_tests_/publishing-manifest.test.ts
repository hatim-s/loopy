import { expect, test } from "bun:test";
import {
  normalizeBundlePath,
  type PublishManifest,
  preparePublishBundle,
  verifyPublishBundle,
} from "../src/publishing/manifest.js";

const manifest: PublishManifest = {
  entrypoint: "src/main.ts",
  files: ["src/main.ts", "bun.lock"],
  sources: [{ source: "main.ts", target: "src/main.ts" }],
  lockfile: "bun.lock",
  compiler: "loopy-compiler@1",
  runtime: { build: "loopy@1", graphSchema: 1 },
};
const encode = (text: string) => new TextEncoder().encode(text);
const read = async (path: string) =>
  encode(path === "bun.lock" ? "pinned dependencies" : "export default workflow");

test("normalizes portable paths and rejects traversal and external references", () => {
  expect(normalizeBundlePath("./src//main.ts")).toBe("src/main.ts");
  for (const path of [
    "../a",
    "a/../b",
    "/etc/passwd",
    "C:/a",
    "a\\b",
    "https://example.com/a",
    "a%2fb",
    "a\0b",
    ".",
  ])
    expect(() => normalizeBundlePath(path)).toThrow();
});

test("bundle hashes bind files, lockfile and build identities without discovering adjacent files", async () => {
  const requested: string[] = [];
  const first = await preparePublishBundle(manifest, async (path) => {
    requested.push(path);
    return read(path);
  });
  expect(requested).toEqual(["bun.lock", "src/main.ts"]);
  const reordered = await preparePublishBundle(
    { ...manifest, files: [...manifest.files].reverse() },
    read,
  );
  expect(first.sha256).toBe(reordered.sha256);
  expect(first.files[0]?.sha256).toBe(first.lockfileHash);
  expect(
    (await preparePublishBundle({ ...manifest, compiler: "compiler@2" }, read)).sha256,
  ).not.toBe(first.sha256);
  expect((await preparePublishBundle(manifest, async () => encode("changed"))).sha256).not.toBe(
    first.sha256,
  );
});

test("invalid declarations fail before reading files", async () => {
  let reads = 0;
  const reader = async () => {
    reads++;
    return encode("file");
  };
  for (const changed of [
    { ...manifest, files: ["src/main.ts", "./src/main.ts", "bun.lock"] },
    { ...manifest, entrypoint: "missing.ts" },
    { ...manifest, sources: [{ source: "../secret", target: "src/main.ts" }] },
    { ...manifest, sources: [{ source: "a", target: "missing.ts" }] },
    {
      ...manifest,
      sources: [
        { source: "a", target: "src/main.ts" },
        { source: "b", target: "src/main.ts" },
      ],
    },
  ])
    await expect(preparePublishBundle(changed, reader)).rejects.toThrow();
  expect(reads).toBe(0);
});

test("enforces file and total bounds and rejects binary files", async () => {
  await expect(
    preparePublishBundle(manifest, read, { maxFiles: 1, maxFileBytes: 100, maxBundleBytes: 200 }),
  ).rejects.toThrow();
  await expect(
    preparePublishBundle(manifest, read, { maxFiles: 2, maxFileBytes: 1, maxBundleBytes: 200 }),
  ).rejects.toThrow();
  await expect(
    preparePublishBundle(manifest, read, { maxFiles: 2, maxFileBytes: 100, maxBundleBytes: 1 }),
  ).rejects.toThrow();
  await expect(preparePublishBundle(manifest, async () => new Uint8Array([255]))).rejects.toThrow(
    "UTF-8",
  );
  await expect(preparePublishBundle(manifest, async () => new Uint8Array([0]))).rejects.toThrow(
    "Binary",
  );
});

test("UTF-8 content round trips exactly, including byte order marks", async () => {
  const bundle = await preparePublishBundle(manifest, async () => encode("\uFEFFhello é"));
  expect(bundle.files[0]?.content).toBe("\uFEFFhello é");
});

test("received bundle verification rejects content and identity changes", async () => {
  const bundle = await preparePublishBundle(manifest, read);
  expect(await verifyPublishBundle(bundle)).toEqual(bundle);
  await expect(verifyPublishBundle({ ...bundle, sha256: "bad" })).rejects.toThrow("identity");
  await expect(
    verifyPublishBundle({
      ...bundle,
      files: bundle.files.map((file) => ({ ...file, content: "changed" })),
    }),
  ).rejects.toThrow("identity");
  await expect(
    verifyPublishBundle({
      ...bundle,
      files: [...bundle.files, { path: "extra.ts", content: "", bytes: 0, sha256: "bad" }],
    }),
  ).rejects.toThrow("match");
});
