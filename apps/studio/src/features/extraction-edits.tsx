import { type ExtractionProposal, ExtractionProposalSchema } from "@loopy/contracts";
import { useEffect, useState } from "react";
import type { ExtractionReviewModel } from "./types";

export type ReviewChanges = {
  resolutions: { question: string; answer: string }[];
  workflow?: ExtractionProposal["workflow"];
  allowNetworkAccess?: boolean;
};

export function ExtractionEdits({
  model,
  disabled,
  onSave,
  onDirty,
}: {
  model: ExtractionReviewModel;
  disabled?: boolean;
  onSave?: (changes: ReviewChanges) => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const parsed = ExtractionProposalSchema.safeParse(model.proposal);
  const proposal = parsed.success ? parsed.data : undefined;
  const [allowNetworkAccess, setAllowNetworkAccess] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [workflow, setWorkflow] = useState(proposal?.workflow);
  const editable = model.status === "draft" || model.status === "blocked";

  const changes = Object.entries(answers)
    .filter(([, answer]) => answer.trim())
    .map(([question, answer]) => ({ question, answer: answer.trim() }));
  const workflowChanged = JSON.stringify(workflow) !== JSON.stringify(proposal?.workflow);
  useEffect(() => {
    onDirty(changes.length > 0 || workflowChanged || allowNetworkAccess);
  }, [changes.length, workflowChanged, allowNetworkAccess, onDirty]);
  if (!proposal || !workflow) return null;
  return (
    <div className="extraction-review-edits">
      {proposal.unresolvedQuestions.length ? (
        <section aria-label="Review questions">
          <h3>Review questions</h3>
          <p>Explain each decision before publishing. Answers are saved with this proposal.</p>
          {proposal.unresolvedQuestions.map((item, index) => (
            <div className="review-field" key={item.question}>
              <span>{item.question}</span>
              <small>
                {item.blocksExecution ? "Blocks publishing" : "Does not block publishing"}
              </small>
              {model.resolutions
                ?.filter((resolution) => resolution.question === item.question)
                .map((resolution) => (
                  <p key={resolution.answer}>Saved answer: {resolution.answer}</p>
                ))}
              {editable ? (
                <textarea
                  aria-label={`Answer question ${index + 1}`}
                  value={answers[item.question] ?? ""}
                  disabled={disabled}
                  onChange={(event) =>
                    setAnswers({ ...answers, [item.question]: event.target.value })
                  }
                  placeholder="Record your answer and the evidence behind it"
                />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {editable &&
      workflow.policies.tools.network === "disabled" &&
      proposal.unresolvedQuestions.some((item) =>
        item.question.includes("The provider cannot enforce network isolation."),
      ) ? (
        <label className="review-network-permission">
          <input
            type="checkbox"
            checked={allowNetworkAccess}
            disabled={disabled}
            onChange={(event) => setAllowNetworkAccess(event.target.checked)}
          />
          <span>
            Allow provider network access. This provider cannot enforce network isolation.
          </span>
        </label>
      ) : null}
      {proposal.removedDetours.length ? (
        <section aria-label="Omitted details">
          <h3>Not recovered into the graph</h3>
          <ul>
            {proposal.removedDetours.map((item) => (
              <li key={item.description}>
                <strong>{item.description}</strong>
                <p>{item.reason}</p>
                <small>Source events: {item.eventIds.join(", ")}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {editable && onSave ? (
        <details>
          <summary>Edit graph name and agent instructions</summary>
          <label className="review-field">
            Graph name
            <input
              value={workflow.name}
              disabled={disabled}
              onChange={(event) => setWorkflow({ ...workflow, name: event.target.value })}
            />
          </label>
          {workflow.nodes
            .filter((node) => node.kind === "agent")
            .map((node) => (
              <label className="review-field" key={node.id}>
                {node.name}
                <textarea
                  value={node.prompt}
                  disabled={disabled}
                  onChange={(event) =>
                    setWorkflow({
                      ...workflow,
                      nodes: workflow.nodes.map((current) =>
                        current.id === node.id && current.kind === "agent"
                          ? { ...current, prompt: event.target.value }
                          : current,
                      ),
                    })
                  }
                />
              </label>
            ))}
        </details>
      ) : null}
      {editable && onSave ? (
        <button
          type="button"
          disabled={disabled || (!changes.length && !workflowChanged && !allowNetworkAccess)}
          onClick={() =>
            void onSave({
              resolutions: changes,
              ...(workflowChanged ? { workflow } : {}),
              ...(allowNetworkAccess ? { allowNetworkAccess: true } : {}),
            })
          }
        >
          Save review changes
        </button>
      ) : null}
    </div>
  );
}
