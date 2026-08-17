# Loopy CLI

Local-first workflow runtime CLI. Install the packed artifact with Bun:

```sh
bun add ./loopy-0.1.0.tgz
loopy --help
```

The package intentionally ships the TypeScript CLI source and its manifest. It
does not ship project state, fixtures, credentials, or `.loopy` databases.

`loopy ui` starts a loopback-only API and serves a built Studio bundle when the
bundle is present. The bearer token is handed to the browser through an
ephemeral bootstrap global and is never placed in a URL or persistent storage.
