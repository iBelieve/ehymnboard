# eHymnBoard

E-ink hymn board: `device/` is Raspberry Pi Pico W firmware (C++, pico-sdk,
CMake), `server/` is a Flask app (Python, uv) with Tailwind-built assets and a
Docker image deployed via dokku. `hardware/` is the KiCad design (no CI).

## CI

GitHub Actions runs on any change to `device/**` or `server/**`, or to the
shared `tools/` and `.jscpd.json` (`.github/workflows/ci-device.yml`,
`ci-server.yml`). **The device build treats all compiler warnings as errors in
CI** (`-Wall -Wextra` plus `-DWERROR=ON`), so fix warnings before pushing even
if a local build only prints them.

All checks below must pass; run them locally before committing.

### device/

- Format: `git ls-files 'src/*.cpp' 'src/*.h' 'test/*.cpp' 'test/*.h' | xargs uv run clang-format -i`
  (CI checks with `--dry-run --Werror`; clang-format is a uv dev dependency)
- Build: configure with `-DWERROR=ON` and build; needs pico-sdk 2.3.1 and
  arm-none-eabi-gcc 15.2.Rel1 (the VS Code Pico extension installs both under
  `~/.pico-sdk`)
- clang-tidy: `uv run clang-tidy` (a uv dev dependency), config in
  `device/.clang-tidy`, all findings are errors; runs against the build's
  `compile_commands.json` (see the workflow for the cross-compile include
  flags). `misc-use-internal-linkage` is on, so file-local functions and
  variables must be `static`; that's what lets `-Wunused-*` catch dead code.
- Host tests: hardware-independent code lives in its own files (no pico-sdk
  includes beyond `test/stubs/`) and is unit and property tested on the host
  with GoogleTest + RapidCheck under ASan/UBSan:
  `cmake -S test -B build-test -G Ninja -DCOVERAGE=ON && ninja -C build-test && ctest --test-dir build-test`.
  New pure source files go in both `CMakeLists.txt` and `test/CMakeLists.txt`.
- Coverage and CRAP: `uv run gcovr --root . --filter 'src/' --object-directory build-test --exclude-throw-branches --cobertura build-test/coverage.xml --fail-under-line 90`
  then `uv run python ../tools/crap.py --coverage build-test/coverage.xml <host-tested src files>`
- Complexity: `uv run lizard --CCN 15 --length 150 --arguments 7 --warnings_only src test`
- Duplicate code: `npx jscpd@5.4.3 device` from the repo root (config in
  `.jscpd.json`, zero tolerance)
- Python: `uv run ruff check .`, `uv run ruff format --check .` and
  `uv run vulture`
- Emulator (`device/emulator/`, TypeScript run directly by Node, no build
  step): `pnpm install`, then `pnpm run typecheck` (tsc 7), `pnpm run lint`
  (oxlint with type-aware rules via tsrs, all errors), `pnpm run format:check`
  (Prettier) and `pnpm test`, which boots `../build/ehymnboard.uf2` (or
  `$FIRMWARE_UF2`) in rp2040js and runs the scenario tests. Only erasable
  TypeScript syntax (no enums or parameter properties); import with `.ts`
  extensions

### server/

- Deps: managed by uv — use `uv add` / `uv add --dev`, never hand-edit version
  pins; CI runs `uv lock --check`
- Lint/format: `uv run ruff check . ../tools` and
  `uv run ruff format --check . ../tools` (`tools/` is the shared CRAP checker)
- Types: `uv run pyright` (zero errors expected)
- Dead code: `uv run vulture` (config and allowlist in `pyproject.toml`)
- Complexity: `uv run lizard --CCN 10 --length 80 --arguments 7 --warnings_only app.py config ../tools`
- Duplicate code: `npx jscpd@5.4.3 server tools` from the repo root
- Dockerfile: hadolint (`docker run --rm -i hadolint/hadolint:v2.15.1 < Dockerfile`)
- Tests: `uv run pytest --cov --cov-report=xml` (unit, Flask integration and
  Hypothesis property tests in `tests/`; coverage must stay at 95%+), then
  `uv run python ../tools/crap.py --coverage coverage.xml app.py` and
  `uv run pytest ../tools`
- E2E: CI runs the built image and `uv run pytest e2e --base-url http://localhost:8000`
  (Playwright); locally, run the server and `uv run playwright install chromium`
  first. Set `E2E_USERNAME`/`E2E_PASSWORD` when basic auth is on
- Assets: pnpm, pinned by `packageManager` in `package.json`; `pnpm install`
  then `pnpm run build` (CI uses `--frozen-lockfile`). New dependency build
  scripts must be allowed or denied under `allowBuilds` in
  `pnpm-workspace.yaml`, or install fails. `minimumReleaseAge` there rejects
  releases under a day old, so don't pin a version published today
- Docker: CI builds the image (`docker build server`); the tailwind/pnpm asset
  build runs inside it

### .github/workflows/

- actionlint (`ci-workflows.yml`) runs on any workflow change
