# Loopy and graph engineering

## Decision

Loopy is a **local-first graph harness for coding agents**. It is a tool for **graph engineering**: designing, executing, observing, and evolving the explicit topology through which agents, deterministic operations, and humans coordinate work.

This terminology replaces the original “loop harness” product framing. It does not rename Loopy, remove loops from the system, or require an immediate breaking rename of persisted workflow contracts.

## Why the category fits

An execution graph has three essential parts:

1. Nodes perform bounded work.
2. Edges encode dependencies and allowed transitions.
3. Durable run state carries inputs, outputs, evidence, decisions, and status through execution.

Loopy makes all three first-class. Its versioned definitions contain nodes and edges; its runtime interprets routing, fan-out, joins, retries, approvals, and terminal states; SQLite persists graph and attempt state; canonical traces make every transition inspectable; replay and checkpoint forks make recovery explicit.

Loopy therefore does more than draw workflows. It supplies the harness that validates, runs, records, interrupts, recovers, and evolves an execution graph around probabilistic agent work.

## The relationship between loops and graphs

A loop and a graph are not competing abstractions.

- An **agent loop** is the reasoning, tool-use, verification, and retry cycle inside one agent node.
- An **execution graph** governs which bounded units may run, what they receive, where their results go, when branches join, and where humans or deterministic checks take control.
- A **graph harness** is the runtime and tooling that make that graph executable, observable, recoverable, and policy-bound.

The name Loopy still fits: it runs and coordinates loops. The product promise is larger than one loop.

## Product philosophy

### Topology over hidden delegation

Important dependencies, branches, joins, approval boundaries, and recovery paths belong in the graph. They should not exist only inside a model's prompt or context window.

### Deterministic structure around probabilistic work

Loopy does not claim agent outputs are deterministic. It makes the surrounding execution plan, policies, state transitions, evidence, and legal recovery paths explicit and testable.

### The graph is an executable contract

The canvas is a view of the same versioned contract the runtime validates and executes. A graph that cannot be compiled, traced, replayed, or recovered is only a diagram.

### Not every node is an agent

Agent nodes are appropriate for ambiguous work. Verification, transformation, routing, joining, waiting, and approval should use deterministic or human-controlled nodes when possible. This reduces cost and uncertainty.

### Experience should compile into structure

Loopy starts from a completed agent trace, preserves evidence, proposes a reusable graph, and asks the user to approve or edit it. “Do it once” is the input to graph engineering, not the final architecture.

### Local ownership is a control boundary

Provider credentials, source code, subprocesses, operational state, and traces remain on the user's machine by default. Local-first is part of the harness's safety model, not merely a deployment choice.

## Brand and messaging

### Category

Local graph harness for coding agents.

### Primary promise

Do the work once. Extract the graph. Run it with control.

### Supporting description

Loopy turns successful Codex, Claude Code, OpenCode, and Pi sessions into editable execution graphs, then runs and debugs those graphs locally with explicit routing, state, policies, evidence, and recovery.

### Vocabulary

| Use | Meaning |
|---|---|
| graph harness | Loopy's product category |
| graph engineering | the discipline Loopy enables |
| execution graph or graph | the user-facing reusable artifact |
| node and edge | work units and their legal dependencies or routes |
| agent loop | open-ended reasoning and tool use inside an agent node |
| workflow | compatibility term in current schemas, APIs, routes, and CLI flags |
| trace-to-graph | extraction of an evidence-backed graph from recorded work |

Avoid using “graph engineering” to mean knowledge graphs, GraphRAG, graph databases, or graph neural networks. Loopy engineers task and execution topology.

## Research basis

“Graph engineering” is an emerging term rather than a settled standard. The useful common definition is explicit execution topology around agent work:

- The [Structured Graph Harness paper](https://arxiv.org/abs/2604.11378) describes lifting control flow from an implicit agent loop into an explicit static DAG with versioned plans and bounded recovery.
- [LangGraph's Graph API](https://langchain-ai.github.io/langgraph/how-tos/state-reducers/) defines agent workflows through shared state, nodes, edges, compilation, parallel activation, and checkpoints.
- [Microsoft Agent Framework Workflows](https://learn.microsoft.com/en-us/agent-framework/workflows/workflows) describes a directed graph runtime with executors, edges, validation, concurrent supersteps, events, and checkpoints.
- A current field definition notes that the label remains non-standard while the underlying mechanics come from established workflow engines, state machines, scheduling, and message passing: [Graph engineering for AI agents](https://codesdevs.io/notes/graph-engineering-ai-agents/).

Loopy should use the category plainly, define it every time the audience may confuse it with knowledge graphs, and avoid claiming that the phrase itself is proprietary or mature.

