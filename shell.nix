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
  ];

  # Canonical dev commands. Short shell aliases are defined in `shellHook`.
  commands = {
    "loom-deps" = "npm install";
    "loom-dev" = "npm run tauri dev";
    "loom-run" = "nix build .# && ./result/bin/langloom";
    "loom-app" = "./result/bin/langloom";
    "loom-pkg" = "nix build .#";
    "loom-fmt" = "cargo fmt --all";
    "loom-fmtcheck" = "cargo fmt --all --check";
    "loom-clippy" = "cargo clippy --workspace --all-targets -- -D warnings";
    "loom-ctest" = "cargo test -p langloom-core";
    "loom-testall" = "cargo test --workspace";
    "loom-fecheck" = "npm run check";
    "loom-febuild" = "npm run build";
    "loom-clean" = "cargo clean && rm -rf dist";
    "loom-gates" = ''
      cargo fmt --all --check \
        && cargo clippy --workspace --all-targets -- -D warnings \
        && cargo test -p langloom-core \
        && npm run check \
        && npm run test \
        && npm run build
    '';
    "loom-help" = ''
      cat <<'EOF'
langloom dev commands
  deps      npm install
  dev       npm run tauri dev            (hot reload)
  run       nix build .# && ./result/bin/langloom
  app       ./result/bin/langloom        (launch existing build)
  pkg       nix build .#
  fmt       cargo fmt --all
  fmtcheck  cargo fmt --all --check
  clippy    cargo clippy --workspace --all-targets -- -D warnings
  ctest     cargo test -p langloom-core
  testall   cargo test --workspace
  fecheck   npm run check                (svelte-check)
  febuild   npm run build
  clean     cargo clean && rm -rf dist
  gates     fmtcheck + clippy + ctest + fecheck + febuild
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
    alias clean=loom-clean
    alias gates=loom-gates
    alias aliases=loom-help
    alias help=loom-help

    echo "langloom dev shell — type 'help' for commands (deps dev run app pkg fmt fmtcheck clippy ctest testall fecheck febuild clean gates)"
  '';
}
