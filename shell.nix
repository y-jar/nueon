{ pkgs ? import <nixpkgs> { } }:

let
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
in
pkgs.mkShell {
  packages = with pkgs; [
    cargo
    rustc
    rust-analyzer
    clippy
    rustfmt
    pkg-config
    git
  ] ++ guiLibs;

  # winit/eframe load these at runtime on Wayland/X11.
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath guiLibs;
}
