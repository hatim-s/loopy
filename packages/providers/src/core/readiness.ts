export type ProviderReadiness = {
  installation: "installed" | "missing";
  authentication: "authenticated" | "unauthenticated" | "unknown";
  usability: "unverified";
  message: string;
  setupCommand: string;
};

const setupCommands: Record<string, string> = {
  codex: "codex login",
  claude: "claude auth login",
  pi: "pi",
  opencode: "opencode auth login",
};

/** Only recognized status output is evidence. Never return raw authentication output. */
export function authenticationStatus(
  provider: string,
  output: string,
): ProviderReadiness["authentication"] {
  if (provider === "codex") {
    if (/^Logged in using /m.test(output)) return "authenticated";
    if (/^Not logged in\s*$/m.test(output)) return "unauthenticated";
  }
  if (provider === "claude") {
    try {
      const value = JSON.parse(output);
      if (value.loggedIn === true) return "authenticated";
      if (value.loggedIn === false) return "unauthenticated";
    } catch {
      /* Older CLIs may not support structured auth status. */
    }
  }
  return "unknown";
}

export function providerReadiness(
  provider: string,
  installed: boolean,
  authentication: ProviderReadiness["authentication"] = "unknown",
): ProviderReadiness {
  return {
    installation: installed ? "installed" : "missing",
    authentication,
    usability: "unverified",
    setupCommand: setupCommands[provider] ?? provider,
    message: !installed
      ? `Install ${provider} and make its executable available on the server PATH, then check again.`
      : authentication === "unauthenticated"
        ? `Sign in with ${setupCommands[provider] ?? provider} in a terminal, then check again.`
        : authentication === "authenticated"
          ? "The CLI reports a local login. Model access and a successful run have not been verified."
          : provider === "pi"
            ? "CLI installed. Select a provider and model in Pi and use /login if needed. Authentication and model access have not been verified."
            : "CLI installed. Authentication and model access have not been verified. Complete setup in a terminal, then check again.",
  };
}
