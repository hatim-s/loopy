import { WorkflowDefinitionSchema, WorkflowPatchSchema } from "@loopy/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type McpApi = (path: string, body?: unknown) => Promise<unknown>;
const inputs = {
  list_workflows: z.object({}),
  inspect_workflow: z.object({ workflowId: z.string().min(1) }),
  create_workflow: z.object({ definition: WorkflowDefinitionSchema }),
  apply_workflow_commands: WorkflowPatchSchema,
  start_run: z.object({
    workflowId: z.string().min(1),
    version: z.number().int().positive(),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
  inspect_run: z.object({ runId: z.string().min(1) }),
  control_run: z.object({
    runId: z.string().min(1),
    action: z.enum(["pause", "resume", "cancel", "retry"]),
    nodeId: z.string().optional(),
  }),
};
const descriptions: Record<keyof typeof inputs, string> = {
  list_workflows: "List persisted Loopy workflow versions in this project.",
  inspect_workflow:
    "Read workflow versions before editing. Use the latest version as the patch baseVersion.",
  create_workflow:
    "Create a versioned Loopy graph. Shell modules execute Bash on the host; agent nodes use the configured provider.",
  apply_workflow_commands:
    "Apply a batch of Loopy workflow operations atomically. A stale baseVersion returns a conflict; inspect again before retrying.",
  start_run:
    "Start a saved workflow version on the background server. The run continues after this client disconnects.",
  inspect_run: "Read persisted run status, node attempts, outputs, and event history.",
  control_run:
    "Pause, resume, cancel, or retry a run. Retry requires nodeId and may execute that node again.",
};
const toolList = Object.entries(inputs).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof inputs],
  inputSchema: {
    ...z.toJSONSchema(schema, { io: "input", reused: "ref", cycles: "ref" }),
    type: "object" as const,
  },
  annotations: {
    readOnlyHint: ["list_workflows", "inspect_workflow", "inspect_run"].includes(name),
    openWorldHint: ["start_run", "control_run"].includes(name),
  },
}));

export function createMcpServer(api: McpApi) {
  const server = new Server(
    { name: "loopy", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Inspect the latest workflow before editing. Use the returned version as baseVersion. Workflow edits and runs share the browser's validation and persistence. Shell modules run on the host.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    try {
      let result: unknown;
      switch (request.params.name) {
        case "list_workflows":
          inputs.list_workflows.parse(args);
          result = await api("/workflows");
          break;
        case "inspect_workflow": {
          const input = inputs.inspect_workflow.parse(args);
          result = await api(`/workflows/${encodeURIComponent(input.workflowId)}`);
          break;
        }
        case "create_workflow":
          result = await api("/workflows", inputs.create_workflow.parse(args));
          break;
        case "apply_workflow_commands": {
          const patch = inputs.apply_workflow_commands.parse(args);
          result = await api(`/workflows/${encodeURIComponent(patch.workflowId)}/patch`, patch);
          break;
        }
        case "start_run":
          result = await api("/runs", inputs.start_run.parse(args));
          break;
        case "inspect_run": {
          const input = inputs.inspect_run.parse(args);
          result = await api(`/runs/${encodeURIComponent(input.runId)}`);
          break;
        }
        case "control_run": {
          const input = inputs.control_run.parse(args);
          if (input.action === "retry" && !input.nodeId) throw new Error("Retry requires nodeId");
          result = await api(`/runs/${encodeURIComponent(input.runId)}/${input.action}`, {
            nodeId: input.nodeId,
          });
          break;
        }
        default:
          throw new Error(`Unknown Loopy tool '${request.params.name}'`);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  });
  return server;
}

export async function handleMcpRequest(request: Request, api: McpApi) {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const server = createMcpServer(api);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    const body = response.body ? await response.arrayBuffer() : null;
    return new Response(body, { status: response.status, headers: response.headers });
  } finally {
    await server.close();
  }
}
export async function startMcpStdio(api: McpApi) {
  const server = createMcpServer(api);
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1_048_576 }),
  );
  return server;
}
