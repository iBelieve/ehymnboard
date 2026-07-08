# eHymnBoard

E-ink hymn board: `device/` is Raspberry Pi Pico W firmware (C++, pico-sdk,
CMake), `server/` is a Flask app (Python, uv) with Tailwind-built assets and a
Docker image deployed via dokku. `hardware/` is the KiCad design (no CI).

## CI

GitHub Actions runs on any change to `device/**` or `server/**`
(`.github/workflows/ci-device.yml`, `ci-server.yml`). **The device build treats
all compiler warnings as errors in CI** (`-Wall -Wextra` plus `-DWERROR=ON`),
so fix warnings before pushing even if a local build only prints them.

All checks below must pass; run them locally before committing.

### device/

- Format: `git ls-files 'src/*.cpp' 'src/*.h' | xargs uv run clang-format -i`
  (CI checks with `--dry-run --Werror`; clang-format is a uv dev dependency)
- Build: configure with `-DWERROR=ON` and build; needs pico-sdk 2.1.1 and
  arm-none-eabi-gcc 14.2.Rel1 (the VS Code Pico extension installs both under
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
- Docker: CI builds the image (`docker build server`); the tailwind/npm asset
  build runs inside it
