// This oracle describes one execution, one indefinite wait, two attempts and two owners.
// It imports no reducer or host transition helpers.
export type ModelAction =
  | "turn"
  | "lookup_loss"
  | "start_loss"
  | "release_loss"
  | "finish"
  | "retry"
  | "vanish"
  | "signal"
  | "advance"
  | "reconstruct";

export type PolicyModel = {
  now: number;
  token: number;
  owner: number | null;
  heartbeat: number;
  run: "queued" | "running" | "suspended" | "succeeded" | "failed";
  node: "new" | "running" | "retrying" | "succeeded" | "failed";
  wait: "new" | "waiting" | "resolved" | "expired";
  attempt: number;
  knownStarted: boolean;
  observation: "none" | "started" | "success" | "retry";
  retryAt: number;
  starts: number;
  logs: string[];
};

export function initialModel(): PolicyModel {
  return {
    now: 0,
    token: 1,
    owner: null,
    heartbeat: 0,
    run: "queued",
    node: "new",
    wait: "new",
    attempt: 0,
    knownStarted: false,
    observation: "none",
    retryAt: 0,
    starts: 0,
    logs: [],
  };
}

export function actions(state: PolicyModel): ModelAction[] {
  const result: ModelAction[] = ["turn"];

  if (state.run === "succeeded" || state.run === "failed") {
    return result;
  }

  if (state.token === 1) {
    result.push("reconstruct");
  }

  if (state.now < 12_000) {
    result.push("advance");
  }

  if (state.wait === "waiting") {
    result.push("signal");
  }

  const ownable =
    state.owner === null || state.owner === state.token || state.now - state.heartbeat > 3000;

  if (
    ownable &&
    (state.node === "new" || (state.node === "retrying" && state.now >= state.retryAt))
  ) {
    result.push("start_loss");
  }

  if (state.node === "running") {
    if (ownable) {
      result.push("lookup_loss");
    }

    if (state.observation === "started") {
      result.push("finish", "retry");

      if (state.knownStarted) {
        result.push("vanish");
      }
    }
  }

  if (
    ownable &&
    state.wait === "waiting" &&
    (state.node === "succeeded" || state.observation === "success")
  ) {
    result.push("release_loss");
  }

  return result;
}

export function modelStep(previous: PolicyModel, action: ModelAction) {
  const state = structuredClone(previous);
  const ok = () => ({ state, error: null });

  switch (action) {
    case "signal":
      state.wait = "resolved";

      return ok();
    case "finish":
      state.observation = "success";

      return ok();
    case "retry":
      state.observation = "retry";

      return ok();
    case "vanish":
      state.observation = "none";

      return ok();
    case "reconstruct":
      state.token = 2;

      return ok();
    case "advance": {
      const boundaries = [
        999,
        1000,
        1001,
        3000,
        3001,
        12_000,
        state.retryAt - 1,
        state.retryAt,
        state.retryAt + 1,
        state.heartbeat + 3000,
        state.heartbeat + 3001,
      ];

      state.now = Math.min(...boundaries.filter((time) => time > state.now));

      return ok();
    }
  }

  if (state.run === "succeeded" || state.run === "failed") {
    return ok();
  }

  if (state.owner !== null && state.owner !== state.token && state.now - state.heartbeat <= 3000) {
    return { state, error: "ownership" };
  }

  if (state.run === "suspended" && state.owner === state.token && action === "release_loss") {
    return { state, error: "release interrupted" };
  }

  state.owner = state.token;
  state.heartbeat = state.now;
  state.run = "running";

  if (state.wait === "new") {
    state.wait = "waiting";
  }

  const starting =
    state.node === "new" || (state.node === "retrying" && state.now >= state.retryAt);

  if (starting) {
    state.node = "running";
    state.attempt++;
    state.starts++;
    state.observation = "started";
    state.knownStarted = action !== "start_loss";

    if (action === "start_loss") {
      return { state, error: "start response lost" };
    }
  } else if (state.node === "running") {
    if (action === "lookup_loss") {
      return { state, error: "lookup unavailable" };
    }

    switch (state.observation) {
      case "started":
        state.knownStarted = true;
        break;
      case "success":
        state.node = "succeeded";
        state.logs.push("success");
        break;
      case "retry":
        state.logs.push("retry");
        state.node = state.attempt < 2 ? "retrying" : "failed";
        state.retryAt = state.now + 1000;
        break;
      case "none":
        state.node = "failed";
        break;
    }
  }

  if (state.node === "failed" || state.node === "succeeded") {
    state.run = state.wait === "resolved" ? state.node : "suspended";

    if (action === "release_loss") {
      return { state, error: "release interrupted" };
    }

    state.owner = null;
  }

  return ok();
}
