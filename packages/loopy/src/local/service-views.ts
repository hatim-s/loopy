import { type RunView, runView } from "../contract/index.js";
import { executionKeyString, type NodeRun, type WaitRecord } from "../core/index.js";

type Options = Omit<Parameters<typeof runView>[0], "steps" | "hooks"> & {
  nodeRuns: NodeRun[];
  hooks: WaitRecord[];
};

export function graphRunView(options: Options): RunView {
  const view = runView({ ...options, steps: [], hooks: [] });

  if (view.status !== "running" && view.status !== "suspended") {
    return view;
  }

  const hook = options.hooks.find((hook) => {
    if (hook.resolvedAt || hook.expiredAt) {
      return false;
    }

    const node = options.nodeRuns.find(
      (node) => executionKeyString(node.key) === executionKeyString(hook.executionKey),
    );

    return (
      node?.status === "waiting" &&
      (node.wakeAt === null || Date.parse(node.wakeAt) > Date.parse(options.now))
    );
  });

  if (!hook) {
    return view;
  }

  const node = options.nodeRuns.find(
    (node) => executionKeyString(node.key) === executionKeyString(hook.executionKey),
  );

  return {
    ...view,
    waitingOn: {
      hook: hook.name,
      token: hook.token,
      seq: hook.seq,
      expiresAt: node?.status === "waiting" ? node.wakeAt : null,
      since: hook.createdAt,
    },
  };
}
