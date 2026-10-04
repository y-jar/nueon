# Standards

## Commit messages

Every completed stage is committed with this subject format:

```
<Subject>: <Feature> + <Feature> [+ <Feature> ...]
```

- **Subject** — the area/stage in one word, uppercase (e.g. `BACKEND`, `MODEL`,
  `STORAGE`, `UI`, `DOCS`).
- **Feature** — a short Title Case description of what landed. Join multiple
  features with ` + `.
- One commit per finished stage; commit before starting the next stage.

An optional body may list details as bullets.

Examples:

```
BACKEND: Tables + Tags + Sparse Storage + Config + Git Check-ins
UI: Three-pane Shell + Command Bar + Sidebar
MODEL: Derivation Engine + Dependency Warnings
```

## Code

- `cargo fmt` and `cargo clippy --all-targets -- -D warnings` must pass.
- All storage writes are atomic; workspace paths are never escaped.
- Git integration goes through the system `git` CLI, never a linked library.
