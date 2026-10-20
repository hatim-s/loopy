import { type GraphView, isRecord, isRef, type Ref, type Value } from "loopy/contract";

type GraphNode = GraphView["nodes"][number];

/** References read by label: `1:plan` with path `dirty` prints as `plan.dirty`. */
export function refText(ref: Ref): string {
  return [ref.ref.replace(/^\d+:/, ""), ...ref.path].join(".");
}

/** Literals print as JSON and references as `node.path`, since they resolve only at run time. */
export function valueText(value: Value): string {
  if (isRef(value)) {
    return refText(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(valueText).join(", ")}]`;
  }

  if (isRecord(value)) {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${key}: ${valueText(item)}`)
      .join(", ")} }`;
  }

  return JSON.stringify(value);
}

type Predicate = Extract<GraphNode, { kind: "branch" }>["predicate"];

type Operand = Extract<Predicate, { left: unknown }>["left"];

const COMPARE = {
  eq: "=",
  ne: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  in: "in",
} satisfies Record<Extract<Predicate, { left: unknown }>["op"], string>;

function operandText(operand: Operand): string {
  return isRef(operand) && "size" in operand ? `size(${refText(operand)})` : valueText(operand);
}

/** A predicate as one readable line, such as `plan.dirty = true and not exists(notes)`. */
export function predicateText(predicate: Predicate): string {
  switch (predicate.op) {
    case "exists":
    case "isNull": {
      return `${predicate.op}(${valueText(predicate.value)})`;
    }

    case "and":
    case "or": {
      return predicate.predicates
        .map((inner) => {
          const text = predicateText(inner);

          return inner.op === "and" || inner.op === "or" ? `(${text})` : text;
        })
        .join(` ${predicate.op} `);
    }

    case "not": {
      return `not ${predicateText(predicate.predicate)}`;
    }

    default: {
      return `${operandText(predicate.left)} ${COMPARE[predicate.op]} ${operandText(predicate.right)}`;
    }
  }
}

/** A value as a person reads it in a line of text: scalars bare, references by name. */
function plainText(value: Value): string {
  return isRef(value) || Array.isArray(value) || isRecord(value) ? valueText(value) : String(value);
}

/** The one line a node shows under its title, or null when its kind has nothing to add. */
export function kindDetail(node: GraphNode): string | null {
  switch (node.kind) {
    case "code": {
      return node.module.name;
    }

    case "command": {
      // Shell commands read best as their argv; named commands by their key.
      return node.key === "sh.exec" ? node.argv.map(plainText).join(" ") : node.key;
    }

    case "branch": {
      return `if ${predicateText(node.predicate)}`;
    }

    case "switch": {
      return `on ${refText(node.on)}`;
    }

    case "map": {
      return `each ${refText(node.over)}, ${node.concurrency} at a time`;
    }

    case "parallel": {
      const count = Object.keys(node.branches).length;

      return `${count} ${count === 1 ? "branch" : "branches"} at once`;
    }

    case "finally": {
      return "cleanup always runs";
    }

    case "rescue": {
      return "handles a failure";
    }

    case "wait": {
      return node.timeout === null ? "no timeout" : `times out after ${node.timeout}`;
    }

    case "sleep": {
      return `for ${node.duration}`;
    }

    case "fail":
    case "log": {
      return plainText(node.message);
    }

    case "format": {
      return node.template;
    }

    case "join": {
      return node.result.kind === "none" ? "no value" : valueText(node.result.value);
    }

    default: {
      return null;
    }
  }
}
