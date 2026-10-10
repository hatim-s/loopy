import type {
  Command,
  CommandNode,
  CommandOutput,
  ConditionNode,
  Value,
  Workflow,
  WorkflowConfig,
  WorkflowNode,
} from "./model.js";
import { context, type WorkflowContext } from "./references.js";
import { compileWorkflow } from "./workflow-validation.js";

/** A literal value, or a callback that builds one from typed references. */
type Author<Input, Steps, T> = T | ((context: WorkflowContext<Input, Steps>) => T);

type Branch = WorkflowNode | readonly WorkflowNode[];

function isAuthorCallback<Input, Steps, T>(
  value: Author<Input, Steps, T>,
): value is (context: WorkflowContext<Input, Steps>) => T {
  return typeof value === "function";
}

function author<Input, Steps, T>(value: Author<Input, Steps, T>): T {
  return isAuthorCallback(value) ? value(context()) : value;
}

function nodeList(branch: Branch): WorkflowNode[] {
  return "kind" in branch ? [branch] : [...branch];
}

export function node(id: string, command: Command): CommandNode {
  return { id, kind: "command", command };
}

export class WorkflowBuilder<Input, Steps = Record<never, never>> {
  constructor(
    readonly slug: string,
    private readonly nodes: readonly WorkflowNode[] = [],
    private readonly summary?: string,
    private readonly settings?: WorkflowConfig,
  ) {}

  description(text: string): WorkflowBuilder<Input, Steps> {
    return new WorkflowBuilder(this.slug, this.nodes, text, this.settings);
  }

  config(settings: WorkflowConfig): WorkflowBuilder<Input, Steps> {
    return new WorkflowBuilder(this.slug, this.nodes, this.summary, settings);
  }

  node<const Id extends string>(
    id: Id,
    command: Author<Input, Steps, Command>,
  ): WorkflowBuilder<Input, Steps & Record<Id, CommandOutput>> {
    return new WorkflowBuilder(
      this.slug,
      [...this.nodes, node(id, author(command))],
      this.summary,
      this.settings,
    );
  }

  condition<const Id extends string>(
    id: Id,
    test: Author<Input, Steps, Value<boolean>>,
    thenBranch: Author<Input, Steps, Branch>,
    elseBranch: Author<Input, Steps, Branch>,
  ): WorkflowBuilder<Input, Steps & Record<Id, { branch: "then" | "else" }>> {
    const condition: ConditionNode = {
      id,
      kind: "condition",
      test: author(test),
      // biome-ignore lint/suspicious/noThenProperty: This is the persisted condition branch key.
      then: nodeList(author(thenBranch)),
      else: nodeList(author(elseBranch)),
    };

    return new WorkflowBuilder(this.slug, [...this.nodes, condition], this.summary, this.settings);
  }

  build(): Workflow {
    return compileWorkflow({
      version: 1,
      slug: this.slug,
      description: this.summary,
      config: this.settings,
      nodes: [...this.nodes],
    });
  }
}

export function trigger<Input = Record<string, never>>(slug: string): WorkflowBuilder<Input> {
  return new WorkflowBuilder<Input>(slug);
}
