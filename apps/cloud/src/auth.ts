import { createClerkClient } from "@clerk/backend";
import type { Authenticator } from "../../../packages/loopy/src/cloud/control.js";

export type ClerkConfig = {
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_JWT_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_AUTHORIZED_PARTIES: string;
};

export function clerkAuthenticator(config: ClerkConfig): Authenticator {
  const authorizedParties = config.CLERK_AUTHORIZED_PARTIES.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    !config.CLERK_PUBLISHABLE_KEY ||
    !config.CLERK_JWT_KEY ||
    !config.CLERK_SECRET_KEY ||
    !authorizedParties.length
  )
    throw new Error(
      "Configure CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, CLERK_JWT_KEY and CLERK_AUTHORIZED_PARTIES",
    );
  for (const party of authorizedParties) {
    const url = new URL(party);
    if (
      url.origin !== party ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    )
      throw new Error("CLERK_AUTHORIZED_PARTIES must contain trusted origins");
  }
  const clerk = createClerkClient({
    publishableKey: config.CLERK_PUBLISHABLE_KEY,
    jwtKey: config.CLERK_JWT_KEY,
    secretKey: config.CLERK_SECRET_KEY,
  });
  return async (request) => {
    // API callers supply bearer tokens. Cookie authentication needs a separate CSRF policy.
    if (!request.headers.get("authorization")?.startsWith("Bearer ")) return undefined;
    const state = await clerk.authenticateRequest(request, {
      authorizedParties,
      acceptsToken: "session_token",
    });
    if (!state.isAuthenticated || state.status !== "signed-in") return undefined;
    const auth = state.toAuth({ treatPendingAsSignedOut: true });
    if (
      !auth.isAuthenticated ||
      auth.tokenType !== "session_token" ||
      !auth.userId ||
      auth.sessionStatus === "pending"
    )
      return undefined;
    // Active organization membership is verified by Clerk's normalized session auth object.
    // Organization actions use explicit custom permissions; personal sessions own their tenant.
    const operations = auth.orgId
      ? [
          ...(auth.has({ permission: "org:loopy:read" }) ? ["read" as const] : []),
          ...(auth.has({ permission: "org:loopy:run" }) ? ["run" as const] : []),
          ...(auth.has({ permission: "org:loopy:cancel" }) ? ["cancel" as const] : []),
        ]
      : (["read", "run", "cancel"] as const);
    return {
      subject: auth.userId,
      tenantId: auth.orgId ? `org:${auth.orgId}` : `user:${auth.userId}`,
      operations,
    };
  };
}
