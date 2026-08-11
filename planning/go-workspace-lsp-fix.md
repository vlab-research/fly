# Fix: Go LSP false-positive diagnostics in Claude Code

## Problem

The repo contains 8 independent Go modules, each with its own `go.mod`:

```
dean/
dinersclub/
exodus/
formcentral/
linksniffer/
message-worker/
scribble/
system/
```

There is no `go.mod` at the repo root. When Claude Code (or any editor using gopls) opens a Go file, gopls anchors itself to the nearest `.git/` directory — the repo root — where it finds no module. This produces the cascade of false diagnostics:

```
go: cannot find main module, but found .git/config in /home/nandan/.../fly
could not import github.com/jackc/pgx/v4 (cannot find package in GOROOT)
undefined: Config, ExternalEvent, pgx, handle, ...
```

Every valid `.go` file in the repo appears broken. The code itself is fine (`go build ./...` inside each module directory succeeds).

## Fix: Go workspace file (`go.work`)

Go 1.18 introduced [workspaces](https://go.dev/ref/mod#workspaces) — a `go.work` file at the repo root that tells the Go toolchain (and gopls) about all modules in the tree. Once present, gopls reads it and correctly resolves imports for all modules.

### Implementation

Create `go.work` at the repo root:

```
go 1.24

use (
	./dean
	./dinersclub
	./exodus
	./formcentral
	./linksniffer
	./message-worker
	./scribble
	./system
)
```

The easiest way to generate this (and the accompanying `go.work.sum`):

```bash
cd /path/to/fly
go work init ./dean ./dinersclub ./exodus ./formcentral ./linksniffer ./message-worker ./scribble ./system
go work sync
```

`go work sync` pulls all transitive dependencies of all modules into `go.work.sum` so the workspace resolves correctly offline.

### What to commit

- `go.work` — commit this; it is the declaration of the workspace
- `go.work.sum` — commit this too; it is to `go.work` what `go.sum` is to `go.mod`

### Adding new Go modules in future

When a new module is added under the repo root, add it to `go.work`:

```bash
go work use ./new-module
```

## Verification

After creating the file, reload the Go language server (in VS Code: "Go: Restart Language Server"; in Claude Code: close and reopen a `.go` file or restart the session). The broken-import diagnostics should disappear from all Go files.

Cross-check that the workspace does not affect individual module builds:

```bash
# Must still work inside each module dir
cd dean && go build ./... && go test ./...
```

Workspace files are purely additive — they do not change how individual modules build or what they depend on.

## Why this is safe

- `go.work` affects only the local workspace; it is ignored when modules are fetched as dependencies by external callers.
- Each module's `go.mod` remains the authoritative dependency spec; `go.work` just tells the toolchain where to find them locally.
- CI pipelines that `cd` into a module directory before running `go build` / `go test` are unaffected (the workspace is visible but harmless).
- If any CI step runs from the repo root and you don't want workspace semantics, set `GOWORK=off` in that step's environment.
