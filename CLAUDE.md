# eHymnBoard

E-ink hymn board: `device/` is Raspberry Pi Pico W firmware (C++, pico-sdk,
CMake), `web/` is the server: a Hono Worker + Durable Object + React admin,
in production on Cloudflare Workers (`hymnboard.sonrise.io`, deployed from
master by Workers Builds), and self-hostable on workerd via a Docker image
deployed with dokku, which serves as the fallback (see `web/README.md`). It
replaced a Flask app (`server/`, last at commit 02ece7f) and keeps its device
protocol byte-for-byte. `hardware/` is the KiCad design
(no CI). `web/`, `e2e/` and `device/emulator/` are one pnpm workspace,
rooted at the repository root (see "pnpm workspace" below).

## CI

One GitHub Actions workflow, `.github/workflows/ci.yml`, runs every check on
every push to master and every pull request, with no path filters, as
parallel jobs. The firmware is built once (the `firmware` job) and the
server's Docker image once (`server-image`); the emulator, Autobahn and e2e
jobs download them as artifacts. The `All green` job passes only if every
other job did and is the one required status check, so a new job needs no
branch protection change, only a line in its `needs` (a step there fails if a
job is missing). `check-pico-sdk.yml` is a separate weekly job, and
`check-tls-roots.yml` a daily one (the live server's certificate chain
against the roots the boards trust; it also runs when they change).
Firmware builds in CI go through `.github/actions/build-firmware`, which pins
the Pico SDK and Arm toolchain. **The device build treats all compiler
warnings as errors in CI** (`-Wall -Wextra` plus `-DWERROR=ON`), so fix
warnings before pushing even if a local build only prints them.

All checks below must pass; run them locally before committing.

### pnpm workspace

- One `pnpm install` at the root installs every package; there's one
  lockfile, `pnpm-lock.yaml`, at the root (CI uses `--frozen-lockfile`).
  pnpm is pinned by `packageManager` in the root `package.json`, Node by
  `.node-version`
- `pnpm-workspace.yaml` lists the packages and holds the catalog: tools every
  package uses (TypeScript, oxlint, tsrs, `@types/node`) are
  versioned there once and depended on as `"catalog:"`. New dependency build
  scripts must be allowed or denied under `allowBuilds` there, or install
  fails. `minimumReleaseAge` there rejects releases under a day old, so don't
  pin a version published today
- Shared configs: each package's `.oxlintrc.json` extends
  `.oxlintrc.base.json` and adds its own plugins, `env` (not inherited) and
  ignores; tsconfigs extend `tsconfig.base.json`
- From the root, `pnpm run typecheck` and `pnpm run lint` run every
  package's checks (each package lints with its own tsconfig)

### Repository-wide: formatting, duplicate code and new dependencies

- Prettier runs once, from the root, over the whole repository:
  `pnpm run format` (or `format:check`, as CI's `repo` job runs). That covers Markdown, YAML (workflows, `.clang-tidy`) and JSON as
  well as the TypeScript. `.prettierignore` lists what's left out: generated
  files, the submodule, vendored code and `device/.vscode/` (the Pico
  extension writes it). C++ is clang-format's and Python ruff's (`device/`)
- Duplicate code: `pnpm run dupes` (jscpd over `device/`, `tools/`, `web/`
  and `e2e/`, config in `.jscpd.json`, zero tolerance)
- New dependencies: `pnpm run check-new-deps` runs
  [latest-or-bust](https://github.com/iBelieve/latest-or-bust), which fails
  if a dependency the branch adds, or whose version it changes (in any
  `package.json` or the catalog), isn't the newest release that
  `minimumReleaseAge` allows, including an upgrade that stops short of it. It
  compares with where the branch left `origin/master` (CI runs it on pull
  requests, against their base) and asks npm-check-updates about only those
  dependencies, so add a dependency at its latest version. To hold one back
  on purpose, exempt it in `latest-or-bust.json` at the root with the reason
  why (see latest-or-bust's README; there's no file while nothing is
  exempt). On GitHub Actions it passes runs that aren't pull requests, and
  Dependabot's and Renovate's PRs

### device/

- Format: `git ls-files 'src/*.cpp' 'src/*.h' 'test/*.cpp' 'test/*.h' | xargs uv run clang-format -i`
  (CI checks with `--dry-run --Werror`; clang-format is a uv dev dependency)
- Build: configure with `-DWERROR=ON` and build; needs pico-sdk 2.3.1 and
  arm-none-eabi-gcc 15.2.Rel1 (the VS Code Pico extension installs both under
  `~/.pico-sdk`), the `lib/pico_fota_bootloader` submodule, `uv sync` (the
  OTA image encryption uses pycryptodome from the uv env) and
  `secrets.cmake` (copy `secrets.example.cmake`, as CI does)
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
  and `uv run lizard --CCN 10 --length 80 --arguments 7 --warnings_only ../tools`
- Python: deps managed by uv (`uv add --dev`, never hand-edit pins; CI runs
  `uv lock --check`); `uv run ruff check . ../tools`,
  `uv run ruff format --check . ../tools`, `uv run vulture` and
  `uv run pytest ../tools` (`tools/` is the CRAP checker, linted and tested
  from here)
- Emulator (`device/emulator/`, TypeScript run directly by Node, no build
  step): `pnpm install` (installs the workspace), then `pnpm run typecheck`
  (tsc 7), `pnpm run lint` (oxlint with type-aware rules via tsrs, all
  errors) and `pnpm test`, which boots
  `../build/ehymnboard.uf2` (or `$FIRMWARE_UF2`) in rp2040js and runs the
  scenario tests. The board talks TLS to the emulator's router, so build it
  with `-DEHYMNBOARD_TEST_ROOT_CA=ON` (as CI does; it needs the example OTA
  key) to trust the test CA in `certs/test/`. `certs/roots.pem` is what real
  boards trust: `check-tls-roots.yml` checks the live server against it
  daily. Only erasable TypeScript syntax (no enums or parameter
  properties); import with `.ts` extensions
- Autobahn: the `ehymnboard_autobahn` build (an echo client on the same
  WebSocket code) runs the Autobahn fuzzingserver's sections 1-7 in the
  emulator: start the container as CI's `autobahn` job does, then
  `node autobahn/run.ts` in `device/emulator` (see `autobahn/README.md`).
  Every case must come back OK, NON-STRICT or INFORMATIONAL

### web/

- Checks: `pnpm run typecheck` (TypeScript 7), `pnpm run lint` (oxlint with
  type-aware rules via tsrs, config in `.oxlintrc.json`), `pnpm run test`,
  `pnpm run build`; formatting is checked once for the whole repository
- After changing `wrangler.jsonc`, regenerate `worker-configuration.d.ts`
  with `pnpm exec wrangler types`
- Don't change the device endpoints' paths, query parameters or response
  bytes, or the `/ws` messages (`state`, `ping`/`pong`, `shown`, close
  codes): the firmware hard-codes them. The rasterizer is compared against
  the old Flask server's output in `test/render.test.ts`
- Docker: the image builds from the repository root, for the workspace's
  lockfile: `docker build -f web/Dockerfile .` (`.dockerignore` at the root
  sends only the root files and `web/`). CI builds it, and dokku builds it the
  same way (see `web/README.md`)

### e2e/

Full-stack tests: the firmware in the emulator talks to a running server's
real HTTP while Playwright drives its admin page (only through the page; no
server internals). CI runs them against the server's Docker image
(`SERVER_DIR`/`SERVER_CONTEXT`/`SERVER_PORT` in `ci.yml`). Same TypeScript conventions as
the emulator.

- Needs the firmware build. The tests import the emulator's source by
  relative path; `ehymnboard-emulator` is a `workspace:*` dependency so a
  filtered install (`pnpm install --filter ehymnboard-e2e...`) brings its
  packages too
- `pnpm install`, `pnpm exec playwright install chromium`, then with a server
  running: `E2E_BASE_URL=http://localhost:8000 E2E_USERNAME=… E2E_PASSWORD=… pnpm test`.
  The server must run with `EXTRA_DEVICE_IDS=0000000000000000` (the emulated
  board's ID), or `/ws` refuses the board
- `pnpm run typecheck`, `pnpm run lint`
- The selectors are what a person sees, so a rewritten admin page passes
  unchanged if it keeps the six text boxes, Apply/Clear buttons,
  "<board> (last seen …" line and the SVG board picture with one `<image>`
  per screen. A test that must change for a rewrite flags a behaviour change

### .github/workflows/

- actionlint (CI's `actionlint` job) lints every workflow
