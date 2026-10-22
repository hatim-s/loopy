FROM oven/bun:1.4.0 AS build
WORKDIR /build
RUN bun add --exact zod@4.6.7
COPY packages/loopy/src ./packages/loopy/src
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
