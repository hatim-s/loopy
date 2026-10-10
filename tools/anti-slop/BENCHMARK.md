# Lint benchmark

Measured locally on 2026-10-10 with Bun 1.4.0 and Node 24.14.1.
Each command ran three times in a fresh process without ESLint caching.
Dependency installation time is excluded. Lint reports source violations;
these timings measure complete diagnostic runs, not a passing source baseline.

Before: `bun run biome check .`, median 0.142 seconds.
After: `bun run lint`, median 2.767 seconds.
After samples: 3.881, 2.734, 2.767 seconds.

ESLint owns code linting and all 18 anti-slop rules. Biome still checks
formatting and import organization. Loopy also runs typed export/throw rules,
SonarJS cognitive complexity, and Unicorn filename/Node-import rules.
The absolute runtime remains a few seconds, so the ESLint migration was retained.
