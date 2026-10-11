# Releasing

How to publish a release. One version bump, one tag, one CI run, then publish
the draft. You only need `git` (and a browser or the `gh` CLI).

## The short version

1. Bump the version, run gates, commit.
2. Push, tag `v<version>`, push the tag.
3. Wait for the **Release** workflow to finish.
4. Publish the draft release.

GitHub Releases are just a place to attach files to a git tag. The workflow
(`.github/workflows/release.yml`) builds the `.AppImage`, `.deb` and `.rpm` on
Ubuntu and attaches them to the release for you — you never download from
Actions and re-upload by hand.

## Step by step

### 1. Bump the version

The version is the release date, `YY.M.D` (no zero padding). In the dev shell:

```sh
nix-shell
bump 26.10.10        # sets it in Cargo, package.json, tauri.conf.json, flake.nix
gates                # runs the full check suite (includes check-version)
```

Commit it (`git commit -am "release: 26.10.10"`). The tag and the version must
agree — `check-version.sh` enforces `v<version>`.

### 2. Push and tag

```sh
git push origin main
git tag v26.10.10
git push origin v26.10.10
```

Pushing the `v*` tag is what starts the Release workflow.

### 3. Watch CI

Go to **github.com/`<you>`/nueon → Actions → Release**. It builds on Ubuntu
(where the AppImage can be built — NixOS can't, see below) and, on success,
creates a **draft** release named `nueon v26.10.10` with the three packages
attached.

### 4. Publish the draft

In the browser: **Releases → the draft → Edit → Publish release**.

Or with the `gh` CLI:

```sh
gh release edit v26.10.10 --draft=false
```

The assets then appear on the public **Releases** page, which is where the
README points users.

### 5. Refresh the Nix `nueon-bin` hash (optional)

`flake.nix`'s `nueon-bin` package fetches the published `.deb` and has a
placeholder hash. After publishing, update it:

```sh
nix-prefetch-url --type sha256 \
  https://github.com/<you>/nueon/releases/download/v26.10.10/nueon_26.10.10_amd64.deb
```

and put the returned hash into `flake.nix`, then `nix build .#nueon-bin`.

## Building locally (optional, for a preview)

`bundle` (alias for `scripts/bundle.sh`) builds `.deb` and `.rpm` locally into
`~/downloads/nueon-<version>/` with a `SHA256SUMS`. The `.AppImage` is attempted
but skipped on NixOS — `linuxdeploy`'s gstreamer plugin needs `/bin/bash`, which
NixOS doesn't provide. That's fine: CI builds the AppImage on Ubuntu, so the tag
push is the complete path.

## Notes

- `releaseDraft: true` means nothing is public until you publish — safe to run
  the tag and inspect the assets first.
- The Release workflow runs on `ubuntu-22.04` for the widest glibc baseline.
- If a release already exists for the tag, the workflow updates that release's
  assets instead of creating a new one.
