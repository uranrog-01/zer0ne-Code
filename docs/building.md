# Building and releasing

Back to the [README](../README.md) · [User guide](guide.md).

## Build and run

Requirements: Windows 10/11 and [Node.js](https://nodejs.org) 22 or newer.

Double-click **`build.bat`** (or run it in a terminal). The first run installs the
build tools; every run compiles the engine and packages the app. Run it again after
any change. The app is then in:

```
dist\win-unpacked\zer0ne Code.exe
```

- `build.bat run` builds and starts the app.
- `build.bat installer` builds, then creates the Windows installer.
- `build.bat test` builds and runs the tests, including the built app.
- `npm run validate` rebuilds, checks, runs both test suites, packages and tests the app.
- `npm run benchmark` measures startup, a 10,000-message history, rendering,
  cold/warm project switches with six interactive shells, output throughput and JavaScript heap growth. Results
  and limits are saved in `test/output/performance-source.json`; validation also
  checks the packaged app against the same budgets.

Validation records a source fingerprint and every check in
`test/output/validation-report.json`. It refuses a release if files changed
during the run. Keep release builds separate from ongoing edits; the built
folder records its version, source fingerprint and file checksums in
`resources/release.json`. The Windows CI workflow runs the same validation and
retains its reports.

## Windows installer

`npm run installer` wraps the validated `dist\win-unpacked` folder in a setup program:

```
dist\zer0ne-Code-Setup-<version>.exe
dist\zer0ne-Code-Setup-<version>.exe.sha256
```

- It refuses a folder whose `resources/release.json` checksums no longer match, so the installer holds exactly the build that was validated.
- It installs per user by default (no administrator prompt) under `%LOCALAPPDATA%\Programs\zer0ne Code`; an all-users install asks for elevation and goes to `C:\Program Files\zer0ne\zer0ne Code`.
- It adds a desktop shortcut and a Start Menu shortcut in a **zer0ne** folder, both with the app's notification identity, shows the MIT license, and stops if zer0ne Code is running.
- Uninstalling keeps your chats, settings and keys in `%APPDATA%\zer0ne Code`; delete that folder to remove them.
- `npm run installer -- --signed` (or `npm run release`) signs the installer and its uninstaller, and refuses an unsigned or invalid signature.

Verify a download before running it:

```powershell
(Get-FileHash .\zer0ne-Code-Setup-<version>.exe -Algorithm SHA256).Hash
Get-AuthenticodeSignature .\zer0ne-Code-Setup-<version>.exe
```

## Signed releases

For a signed public release, configure `CSC_LINK` (a CA-issued signing certificate
path or base64 certificate) and `CSC_KEY_PASSWORD`, then run **`npm run release`**.
It runs validation, builds the signed installer and refuses a missing or invalid signature. GitHub’s manual
signed-release workflow uses the `release` environment secrets
`WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`. A local private-CA
certificate can be selected for development builds with
`ZER0NE_SIGN_CERT_SHA1`; other computers need to trust its issuing CA. Local
signing does not establish a publicly trusted publisher identity.

## Develop

```
npm install
npm start            # build the engine, then run the app from source
npm run dev          # run the app without rebuilding the engine
npm run check        # type-check the engine, check the app's JavaScript
npm test             # the app's tests (engine host, desktop layer, the running app)
npm run test:engine  # the engine's own test suite
npm run validate     # complete validation, including a freshly packaged app
```

`npm run host` runs one engine without the app and prints a URL any browser can open.

### Command line

```
npm run agent -- --project <folder> --prompt "fix the failing test"   # or --stdin
npm run agent -- --project . --json --timeout-sec 900 --stdin < task.md
npm run mcp        # zer0ne as an MCP server (stdio) for Claude Code, Codex, Zed…
npm run evals -- --list   # behavioral evals against a configured model
```

`npm run agent` runs one whole agent turn from any terminal: it reads files,
edits, runs commands (mode `--mode full|agent` controls approvals) and prints
the answer plus the files it changed. `--json` emits a machine-readable report;
the exit code says completed (0), failed (1) or stopped/timed out (2). The MCP
server exposes the same turns as a `zer0ne_prompt` tool any MCP client can call.
Evals replay scripted tasks in throwaway folders and grade the outcome; point
them at a provider with `ZER0NE_EVAL_CONFIG` (a JSON file with `baseUrl`,
`apiKey`, `model`) or `ZER0NE_EVAL_BASE_URL` / `ZER0NE_EVAL_MODEL`. For
post-hoc debugging, `ZER0NE_TRACE_DIR=<folder>` writes one JSONL trace per turn.

The npm test commands rebuild the engine first. `npm run test:live` runs the network and real-browser suites.
