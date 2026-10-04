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
  ];

  # WebKitGTK loaded at runtime by the Tauri webview.
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtimeLibs;

  # Avoid blank/black webview windows on Wayland and broken DMA-BUF paths.
  WEBKIT_DISABLE_DMABUF_RENDERER = "1";
  WEBKIT_DISABLE_COMPOSITING_MODE = "1";
}
