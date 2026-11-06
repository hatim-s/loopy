FROM oven/bun:1.4.0 AS build
WORKDIR /build
RUN printf '%s\n' '{"private":true,"type":"module","workspaces":["packages/*"],"dependencies":{"effect":"4.1.2","@loopy/core":"workspace:*","@loopy/contract":"workspace:*","@loopy/runtime":"workspace:*"}}' > package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/core/src ./packages/core/src
COPY packages/contract/package.json ./packages/contract/package.json
COPY packages/contract/src ./packages/contract/src
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/sdk/src ./packages/sdk/src
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY packages/runtime/src ./packages/runtime/src
RUN bun install --production --ignore-scripts
COPY apps/sandbox/src ./apps/sandbox/src
RUN bun build apps/sandbox/src/worker.ts --target=bun --outfile=/worker.js \
    && bun build apps/sandbox/src/artifact-worker.ts --target=bun --outfile=/artifact-worker.js

FROM oven/bun:1.4.0
USER root
RUN mkdir -p /opt/loopy /input /workspace && chown 1000:1000 /workspace && chmod 755 /input
COPY --from=build /worker.js /opt/loopy/worker.js
COPY --from=build /artifact-worker.js /opt/loopy/artifact-worker.js
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["bun", "/opt/loopy/worker.js"]
