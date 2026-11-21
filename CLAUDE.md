# eHymnBoard

E-ink hymn board: `device/` is Raspberry Pi Pico W firmware (C++, pico-sdk,
CMake), `server/` is a Flask app (Python, uv) with Tailwind-built assets and a
Docker image deployed via dokku. `web/` is its TypeScript replacement (Hono
Worker + Durable Object + React, self-hosted on workerd via Docker; see
`web/README.md`), keeping the device protocol byte-for-byte. `hardware/` is the
KiCad design (no CI).

## CI

GitHub Actions runs on any change to `device/**`, `server/**` or `web/**`
(`.github/workflows/ci-device.yml`, `ci-server.yml`, `ci-web.yml`). **The
device build treats all compiler warnings as errors in CI** (`-Wall -Wextra`
plus `-DWERROR=ON`), so fix warnings before pushing even if a local build only
prints them.

All checks below must pass; run them locally before committing.

### device/

- Format: `git ls-files 'src/*.cpp' 'src/*.h' | xargs uv run clang-format -i`
  (CI checks with `--dry-run --Werror`; clang-format is a uv dev dependency)
- Build: configure with `-DWERROR=ON` and build; needs pico-sdk 2.3.1 and
  arm-none-eabi-gcc 15.2.Rel1 (the VS Code Pico extension installs both under
  `~/.pico-sdk`)
- clang-tidy: `uv run clang-tidy` (a uv dev dependency), config in
  `device/.clang-tidy`, all findings are errors; runs against the build's
  `compile_commands.json` (see the workflow for the cross-compile include
  flags)
- Python: `uv run ruff check .` and `uv run ruff format --check .`

### server/

- Deps: managed by uv — use `uv add` / `uv add --dev`, never hand-edit version
  pins; CI runs `uv lock --check`
- Lint/format: `uv run ruff check .` and `uv run ruff format --check .`
- Types: `uv run pyright` (zero errors expected)
- Assets: pnpm, pinned by `packageManager` in `package.json`; `pnpm install`
  then `pnpm run build` (CI uses `--frozen-lockfile`). New dependency build
  scripts must be allowed or denied under `allowBuilds` in
  `pnpm-workspace.yaml`, or install fails. `minimumReleaseAge` there rejects
  releases under a day old, so don't pin a version published today
- Docker: CI builds the image (`docker build server`); the tailwind/pnpm asset
  build runs inside it

### web/

- Deps: pnpm, pinned by `packageManager` in `package.json`, same
  `allowBuilds` and `minimumReleaseAge` rules as `server/` (in
  `web/pnpm-workspace.yaml`)
- Checks: `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`,
  `pnpm run test`, `pnpm run build`
- After changing `wrangler.jsonc`, regenerate `worker-configuration.d.ts`
  with `pnpm exec wrangler types`
- Don't change the device endpoints' paths, query parameters or response
  bytes: the firmware hard-codes them. The rasterizer is compared against
  Flask's output in `test/render.test.ts`
- Docker: CI builds the image (`docker build web`)
