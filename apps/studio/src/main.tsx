import "@radix-ui/themes/styles.css";
import { Theme } from "@radix-ui/themes";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  bootstrapSession,
  createApiClient,
  createAuthenticatedApiClient,
  type StudioSessionHandoff,
} from "./app/api";
import { createStudioQueryClient } from "./app/query";
import { createStudioRouter } from "./app/router";
import "./styles/tokens.css";
import "./styles/studio.css";

async function startStudio() {
  const bootstrap = await bootstrapSession().catch((): StudioSessionHandoff => ({}));
  const api = bootstrap.token
    ? createAuthenticatedApiClient({ token: bootstrap.token, baseUrl: bootstrap.baseUrl })
    : createApiClient({ baseUrl: bootstrap.baseUrl });
  const queryClient = createStudioQueryClient(api);
  const router = createStudioRouter({ api, queryClient });
  const root = document.getElementById("root");
  if (!root) throw new Error("Studio root element is missing");
  createRoot(root).render(
    <StrictMode>
      <Theme appearance="dark" accentColor="amber" grayColor="slate" radius="none" scaling="100%">
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Theme>
    </StrictMode>,
  );
}
void startStudio();
