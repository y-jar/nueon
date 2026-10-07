{ pkgs ? import <nixpkgs> { } }:

let
  # Native libraries required by Tauri v2 (wry / WebKitGTK) on Linux.
  tauriLibs = with pkgs; [
    webkitgtk_4_1
    gtk3
    libsoup_3
    librsvg
    gdk-pixbuf
    glib
    cairo
    pango
    harfbuzz
    openssl
  ];

  guiLibs = with pkgs; [
    libGL
    libxkbcommon
    wayland
    libx11
    libxcursor
    libxi
    libxrandr
    fontconfig
    freetype
  ];

  runtimeLibs = tauriLibs ++ guiLibs;

  # Tools every `loom-*` command may need on its PATH.
  tools = with pkgs; [
    nix
    cargo
    rustc
    clippy
    rustfmt
    nodejs_22
    git
    # Regenerate/verify the app icons, and validate the desktop entry.
    imagemagick
    desktop-file-utils
    # Lint the GitHub Actions workflows.
    actionlint
  ];

  # Canonical dev commands. Short shell aliases are defined in `shellHook`.
  commands = {
    "loom-deps" = "npm install";
    "loom-dev" = "npm run tauri dev";
    "loom-run" = "nix build .# && ./result/bin/nueon";
    "loom-app" = "./result/bin/nueon";
    "loom-pkg" = "nix build .#";
    "loom-fmt" = "cargo fmt --all";
    "loom-fmtcheck" = "cargo fmt --all --check";
    "loom-clippy" = "cargo clippy --workspace --all-targets -- -D warnings";
    "loom-ctest" = "cargo test -p nueon-core";
    "loom-testall" = "cargo test --workspace";
    "loom-fecheck" = "npm run check";
    "loom-febuild" = "npm run build";
    "loom-icons" = "sh scripts/make-icons.sh";
    "loom-iconcheck" = "sh scripts/check-icons.sh";
    "loom-bump" = "sh scripts/bump-version.sh";
    "loom-versioncheck" = "sh scripts/check-version.sh";
    "loom-clean" = "cargo clean && rm -rf dist";
    # Keep in sync with .github/workflows/ci.yml (canonical list in AGENTS.md).
    "loom-gates" = ''
      npm run build \
        && cargo fmt --all --check \
        && cargo clippy --workspace --all-targets -- -D warnings \
        && cargo test --workspace \
        && npm run check \
        && npm run test \
        && sh scripts/check-icons.sh \
        && sh scripts/test-version.sh \
        && sh scripts/check-version.sh
    '';
    "loom-help" = ''
      cat <<'EOF'
nueon dev commands
  deps      npm install
  dev       npm run tauri dev            (hot reload)
  run       nix build .# && ./result/bin/nueon
  app       ./result/bin/nueon        (launch existing build)
  pkg       nix build .#
  fmt       cargo fmt --all
  fmtcheck  cargo fmt --all --check
  clippy    cargo clippy --workspace --all-targets -- -D warnings
  ctest     cargo test -p nueon-core
  testall   cargo test --workspace
  fecheck   npm run check                (svelte-check)
  febuild   npm run build
  icons     regenerate the app icon set from assets/branding/nueon-logo.png
  iconcheck verify the generated icons (size + alpha)
  bump      set the app version (defaults to today's YY.M.D)
  versioncheck verify the app version is consistent and sane
  clean     cargo clean && rm -rf dist
  gates     febuild + fmtcheck + clippy + testall + fecheck + iconcheck
            + version tests + version check (mirrors .github/workflows/ci.yml)
EOF
    '';
  };

  commandPackages = pkgs.lib.mapAttrsToList
    (name: text: pkgs.writeShellApplication {
      inherit name text;
      runtimeInputs = tools;
    })
    commands;
in
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    pkg-config
  ];

  buildInputs = runtimeLibs;

  packages = with pkgs; [
    cargo
    rustc
    rust-analyzer
    clippy
    rustfmt
    git
    nodejs_22
    # Regenerate/verify the app icons, and validate the desktop entry.
    imagemagick
    desktop-file-utils
    # Lint the GitHub Actions workflows.
    actionlint
    # Packaged-build probes (probes/): virtual display for the webview.
    xorg-server
  ] ++ commandPackages;

  # WebKitGTK loaded at runtime by the Tauri webview.
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtimeLibs;

  # Avoid blank/black webview windows on Wayland and broken DMA-BUF paths.
  WEBKIT_DISABLE_DMABUF_RENDERER = "1";
  WEBKIT_DISABLE_COMPOSITING_MODE = "1";

  shellHook = ''
    alias deps=loom-deps
    alias dev=loom-dev
    alias run=loom-run
    alias app=loom-app
    alias pkg=loom-pkg
    alias fmt=loom-fmt
    alias fmtcheck=loom-fmtcheck
    alias clippy=loom-clippy
    alias ctest=loom-ctest
    alias testall=loom-testall
    alias fecheck=loom-fecheck
    alias febuild=loom-febuild
    alias icons=loom-icons
    alias iconcheck=loom-iconcheck
    alias bump=loom-bump
    alias versioncheck=loom-versioncheck
    alias clean=loom-clean
    alias gates=loom-gates
    alias aliases=loom-help
    alias help=loom-help

    echo "nueon dev shell — type 'help' for commands (deps dev run app pkg fmt fmtcheck clippy ctest testall fecheck febuild icons iconcheck bump versioncheck clean gates)"
  '';
}
