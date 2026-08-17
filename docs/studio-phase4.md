# Studio Phase 4 local demo

The checked-in `fixtures/studio/demo.json` is sanitized and provider-free. Build the Studio bundle, then serve the Vite preview from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/studio build
bun run --cwd apps/studio preview --host 127.0.0.1
```

The browser API defaults to `/api/v1`. A local API server must be reverse-proxied to that path and supplied an in-memory bearer token by the host page or cookie bootstrap. Tokens are never put in URLs or `localStorage`.

Replay in the debugger is stored-event playback. It only dispatches the events already loaded into the browser and does not call a provider. Fork remains disabled until the runtime exposes durable checkpoint storage; the disabled explanation is intentional.
