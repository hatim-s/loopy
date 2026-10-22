import type { GraphView, OutSchema, Value } from "loopy/contract";
import { predicateText, refText, valueText } from "./graph-text.ts";

type GraphNode = GraphView["nodes"][number];

type Fact = [label: string, value: string];

function outText(out: OutSchema): string {
  return out.kind === "value"
    ? out.type
    : `{ ${Object.entries(out.fields)
        .map(([name, type]) => `${name}: ${type}`)
        .join(", ")} }`;
}

function entries(prefix: string, record: Record<string, Value>): Fact[] {
  return Object.entries(record).map(([key, value]) => [`${prefix}${key}`, valueText(value)]);
}

function optional(label: string, value: Value | null): Fact[] {
  return value === null ? [] : [[label, valueText(value)]];
}

function rateLimit(limit: Extract<GraphNode, { kind: "code" }>["rateLimit"]): Fact[] {
  return limit === null ? [] : [["rate limit", `${limit.limit} per ${limit.window}`]];
}

function targets(prefix: string, record: Record<string, string>): Fact[] {
  return Object.entries(record).map(([key, id]) => [`${prefix}${key}`, id]);
}

/** The compiled settings a reader needs to judge a node, as label and text pairs. */
export function nodeFacts(node: GraphNode): Fact[] {
  switch (node.kind) {
    case "code": {
      return [
        ["module", node.module.name],
        ...entries("in.", node.in),
        ["out", outText(node.out)],
        ["retry", `${node.retry.attempts} attempts, ${node.retry.backoff}`],
        ["timeout", node.timeout === null ? "default" : String(node.timeout)],
        ...rateLimit(node.rateLimit),
      ];
    }

    case "command": {
      return [
        ["command", node.key],
        ["argv", node.argv.map(valueText).join(" ")],
        ...entries("flag.", node.flags),
        ...optional("stdin", node.options.stdin),
        ...optional("cwd", node.options.cwd),
        ...entries("env.", node.options.env),
        ["ok exit codes", node.okExitCodes.join(", ")],
        ["out", outText(node.out)],
        ["retry", `${node.retry.attempts} attempts, ${node.retry.backoff}`],
        ...rateLimit(node.rateLimit),
      ];
    }

    case "branch": {
      return [
        ["predicate", predicateText(node.predicate)],
        ["yes", node.arms.yes],
        ["no", node.arms.no],
      ];
    }

    case "switch": {
      return [
        ["on", refText(node.on)],
        ...targets("case.", node.cases),
        ["default", node.default ?? "none"],
      ];
    }

    case "map": {
      return [
        ["over", refText(node.over)],
        ["body", node.body],
        ["concurrency", String(node.concurrency)],
        ["on error", node.onError],
      ];
    }

    case "parallel": {
      return targets("branch.", node.branches);
    }

    case "wait": {
      return [
        ["timeout", node.timeout === null ? "none" : String(node.timeout)],
        ["payload", outText(node.payload)],
      ];
    }

    case "sleep": {
      return [["duration", String(node.duration)]];
    }

    case "finally": {
      return [
        ["body", node.body],
        ["cleanup", node.cleanup],
      ];
    }

    case "rescue": {
      return [
        ["body", node.body],
        ["handler", node.handler],
      ];
    }

    case "fail": {
      return [["message", valueText(node.message)]];
    }

    case "format": {
      return [["template", node.template], ...entries("value.", node.values)];
    }

    case "log": {
      return [["message", valueText(node.message)], ...optional("data", node.data)];
    }

    case "join": {
      return [["result", node.result.kind === "none" ? "none" : valueText(node.result.value)]];
    }

    default: {
      return [];
    }
  }
}
