import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { Registry, type SavedWorkflow } from "../local/registry.js";
import { SecretStore, validateSecretName, validateSecretValue } from "../local/secrets.js";

async function readSecret(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    if (process.stdin.isTTY)
      throw new Error("--stdin requires piped input. Omit it to enter a secret privately.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 64 * 1024 + 2) throw new Error("Secret input exceeds 64 KiB.");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error(
      "Secret entry requires a terminal. Pipe the value with --stdin for automation.",
    );
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const terminal = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
    historySize: 0,
  });
  process.stderr.write("Secret value (hidden): ");
  try {
    return await new Promise<string>((resolve, reject) => {
      terminal.once("line", resolve);
      terminal.once("close", () => reject(new Error("Secret entry cancelled.")));
      terminal.once("SIGINT", () => terminal.close());
    });
  } finally {
    terminal.close();
    muted.end();
    process.stderr.write("\n");
  }
}

export async function manageSecrets(home: string, cwd: string, args: string[], fromStdin = false) {
  const [action, name, ...rest] = args;
  if (["bind", "unbind", "bindings"].includes(action ?? "")) {
    if (fromStdin) throw new Error("--stdin is only supported by loopy secrets set.");
    if (!name) throw new Error("A saved workflow slug is required.");
    const registry = new Registry(home, cwd);
    let saved: SavedWorkflow;
    if (action === "bind") {
      const [environment, secret, ...extra] = rest;
      if (!environment || !secret || extra.length)
        throw new Error("Use loopy secrets bind <slug> <ENV_VAR> <secret-name>.");
      new SecretStore(home).get(secret);
      saved = registry.bindSecret(name, environment, secret);
    } else if (action === "unbind") {
      const [environment, ...extra] = rest;
      if (!environment || extra.length)
        throw new Error("Use loopy secrets unbind <slug> <ENV_VAR>.");
      saved = registry.unbindSecret(name, environment);
    } else {
      if (rest.length) throw new Error("Use loopy secrets bindings <slug>.");
      saved = registry.get(name);
    }
    console.log(JSON.stringify({ slug: name, bindings: saved.secretBindings?.env ?? {} }, null, 2));
    return;
  }
  if (rest.length)
    throw new Error(
      "Unexpected secret arguments. Values must be entered privately or supplied through --stdin.",
    );
  if (fromStdin && action !== "set")
    throw new Error("--stdin is only supported by loopy secrets set.");
  const store = new SecretStore(home);
  switch (action) {
    case "list":
      if (name) throw new Error("loopy secrets list takes no name.");
      console.log(JSON.stringify(store.list(), null, 2));
      return;
    case "set": {
      if (!name) throw new Error("A secret name is required.");
      validateSecretName(name);
      const value = await readSecret(fromStdin);
      validateSecretValue(value);
      store.set(name, value);
      console.log(JSON.stringify({ name, saved: true }));
      return;
    }
    case "remove":
      if (!name) throw new Error("A secret name is required.");
      store.remove(name);
      console.log(JSON.stringify({ name, removed: true }));
      return;
    default:
      throw new Error(
        "Use loopy secrets set <name>, list, remove <name>, bind, unbind, or bindings.",
      );
  }
}
