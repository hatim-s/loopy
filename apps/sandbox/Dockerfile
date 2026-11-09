FROM oven/bun:1.4.0 AS build
WORKDIR /build
# Dockerfile.dockerignore limits the context to manifests, the lockfile and package sources.
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @loopy/sandbox
RUN bun build apps/sandbox/src/worker.ts --target=bun --outfile=/worker.js \
    && bun build apps/sandbox/src/artifact-worker.ts --target=bun --outfile=/artifact-worker.js

FROM oven/bun:1.4.0
USER root
# Paths match apps/sandbox/src/container-layout.ts.
RUN mkdir -p /opt/loopy /input /workspace && chown 1000:1000 /workspace && chmod 755 /input
COPY --from=build /worker.js /opt/loopy/worker.js
COPY --from=build /artifact-worker.js /opt/loopy/artifact-worker.js
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["bun", "/opt/loopy/worker.js"]
