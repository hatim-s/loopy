import type { ValueReference, WorkflowDefinition } from "@loopy/contracts";

export function ValueSource({
  label,
  value,
  workflow,
  onChange,
}: {
  label: string;
  value: ValueReference;
  workflow: WorkflowDefinition;
  onChange: (value: ValueReference) => void;
}) {
  const mode =
    value.kind === "literal"
      ? "literal"
      : value.kind === "workflow_input"
        ? `input:${value.name}`
        : `node:${value.nodeId}`;
  return (
    <fieldset className="value-source">
      <legend>{label}</legend>
      <select
        aria-label={`${label} source`}
        value={mode}
        onChange={(event) => {
          const selected = event.target.value;
          onChange(
            selected === "literal"
              ? { kind: "literal", value: "" }
              : selected.startsWith("input:")
                ? { kind: "workflow_input", name: selected.slice(6) }
                : { kind: "node_output", nodeId: selected.slice(5), path: ["stdout"] },
          );
        }}
      >
        <option value="literal">A value</option>
        {workflow.inputs.map((input) => (
          <option key={input.name} value={`input:${input.name}`}>
            Input · {input.name}
          </option>
        ))}
        {workflow.nodes.map((node) => (
          <option key={node.id} value={`node:${node.id}`}>
            Step · {node.name}
          </option>
        ))}
      </select>
      {value.kind === "node_output" ? (
        <input
          aria-label={`${label} output path`}
          value={value.path.join(".")}
          placeholder="stdout"
          onChange={(event) =>
            onChange({ ...value, path: event.target.value.split(".").filter(Boolean) })
          }
        />
      ) : null}
      {value.kind === "literal" ? (
        <>
          <select
            aria-label={`${label} value type`}
            value={typeof value.value}
            onChange={(event) =>
              onChange({
                kind: "literal",
                value:
                  event.target.value === "number"
                    ? 0
                    : event.target.value === "boolean"
                      ? true
                      : "",
              })
            }
          >
            <option value="string">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
            {typeof value.value === "object" ? <option value="object">JSON</option> : null}
          </select>
          {typeof value.value === "boolean" ? (
            <select
              aria-label={`${label} value`}
              value={String(value.value)}
              onChange={(event) =>
                onChange({ kind: "literal", value: event.target.value === "true" })
              }
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              aria-label={`${label} value`}
              type={typeof value.value === "number" ? "number" : "text"}
              value={
                typeof value.value === "object" ? JSON.stringify(value.value) : String(value.value)
              }
              onChange={(event) =>
                onChange({
                  kind: "literal",
                  value:
                    typeof value.value === "number"
                      ? Number(event.target.value)
                      : event.target.value,
                })
              }
            />
          )}
        </>
      ) : null}
    </fieldset>
  );
}
