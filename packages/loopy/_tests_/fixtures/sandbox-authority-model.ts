// This model describes the contract without importing runtime transitions or schemas.
export type ModelAttempt = "absent" | "started" | "finished-a" | "finished-b";

export interface AuthorityModel {
  session: "first" | "second";
  attempts: [ModelAttempt, ModelAttempt, ModelAttempt];
  guard: boolean;
  released: boolean;
}

export const modelActions = [
  "rotate",
  "admit0",
  "admit1",
  "admit2",
  "changed0",
  "staleAdmit",
  "completeA",
  "completeB",
  "staleComplete",
  "begin",
  "end",
  "staleEnd",
  "foreignEnd",
] as const;

export type ModelAction = (typeof modelActions)[number];

export function initialModel(): AuthorityModel {
  return {
    session: "first",
    attempts: ["absent", "absent", "absent"],
    guard: false,
    released: false,
  };
}

export function modelStep(state: AuthorityModel, action: ModelAction) {
  const next = structuredClone(state);
  const reply = transition(next, action);

  return { state: next, reply };
}

function transition(state: AuthorityModel, action: ModelAction): string {
  const attempt = state.attempts[0];

  switch (action) {
    case "rotate":
      state.session = "second";

      return "session";
    case "admit0":
    case "admit1":
    case "admit2":
    case "staleAdmit": {
      if (action === "staleAdmit" && state.session === "second") {
        return "stale_session";
      }

      const index = action === "admit1" ? 1 : action === "admit2" ? 2 : 0;

      if (state.attempts[index] !== "absent") {
        return "existing";
      }

      if (index !== 2 && state.guard) {
        return "workspace_busy";
      }

      state.attempts[index] = "started";

      return "created";
    }

    case "changed0":
      if (attempt === "absent") {
        return "skip";
      }

      return "request_conflict";
    case "completeA":
    case "completeB":
    case "staleComplete": {
      if (action === "staleComplete" && state.session === "second") {
        return "stale_session";
      }

      if (attempt === "absent") {
        return "missing";
      }

      const target = action === "completeB" ? "finished-b" : "finished-a";

      if (attempt !== "started" && attempt !== target) {
        return "request_conflict";
      }

      state.attempts[0] = target;

      return "finished";
    }

    case "begin":
      if (state.released) {
        return "invalid_state";
      }

      if (attempt === "absent") {
        return "missing";
      }

      if (attempt === "started") {
        return "invalid_state";
      }

      if (state.guard) {
        return "granted";
      }

      if (state.attempts[1] === "started") {
        return "workspace_busy";
      }

      state.guard = true;

      return "granted";
    case "end":
      if (state.guard) {
        state.released = true;
      }

      state.guard = false;

      return "released";
    case "staleEnd":
      if (state.session === "second") {
        return "stale_session";
      }

      if (state.guard) {
        state.released = true;
      }

      state.guard = false;

      return "released";
    case "foreignEnd":
      return "released";
  }
}

export function enumerateAuthorityModel(depth: number) {
  const initial = initialModel();
  const queue: { state: AuthorityModel; trace: ModelAction[] }[] = [{ state: initial, trace: [] }];
  const visited = new Set([JSON.stringify(initial)]);
  let transitions = 0;
  const representatives: ModelAction[][] = [];

  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index];

    if (!entry || entry.trace.length === depth) {
      continue;
    }

    for (const action of modelActions) {
      const result = modelStep(entry.state, action);
      transitions++;

      if (result.reply === "skip") {
        continue;
      }

      const trace = [...entry.trace, action];
      const before = entry.state.attempts[0];

      if (before.startsWith("finished") && result.state.attempts[0] !== before) {
        throw new Error(`Terminal changed, shortest trace: ${trace.join(",")}`);
      }

      if (entry.state.guard && action === "admit1" && result.reply === "created") {
        throw new Error(`Guard failed, shortest trace: ${trace.join(",")}`);
      }

      const key = JSON.stringify(result.state);

      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: result.state, trace });
        representatives.push(trace);
      }
    }
  }

  return { states: visited.size, transitions, representatives };
}
