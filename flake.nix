{
  description = "langloom — conlang editor and creation app";

  inputs.nixpkgs.url = "nixpkgs";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };

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

      # The Vite/Svelte frontend, built with a lockfile-pinned npm closure.
      frontend = pkgs.buildNpmPackage {
        pname = "langloom-frontend";
        version = "0.1.0";
        src = ./.;
        npmDepsHash = "sha256-3h5wtpKiSVsnCaBzn0HZY/4YpDQN16Lc1vL94e0bedc=";
        npmBuildScript = "build";
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -r dist/. $out/
          runHook postInstall
        '';
      };
    in
    {
      packages.${system}.default = pkgs.rustPlatform.buildRustPackage {
        pname = "langloom";
        version = "0.1.0";
        src = ./.;
        cargoLock.lockFile = ./Cargo.lock;

        nativeBuildInputs = with pkgs; [
          pkg-config
          wrapGAppsHook3
          autoPatchelfHook
        ];
        buildInputs = runtimeLibs;

        doCheck = false;

        # Tauri embeds the built frontend from `../dist` at compile time.
        preBuild = ''
          cp -r ${frontend} dist
        '';

        installPhase = ''
          runHook preInstall
          install -Dm755 \
            "$(find target -type f -name langloom -path '*/release/langloom' -print -quit)" \
            $out/bin/langloom

          install -Dm644 ${./packaging/langloom.desktop} \
            $out/share/applications/langloom.desktop

          install -Dm644 src-tauri/icons/32x32.png \
            $out/share/icons/hicolor/32x32/apps/langloom.png
          install -Dm644 src-tauri/icons/128x128.png \
            $out/share/icons/hicolor/128x128/apps/langloom.png
          install -Dm644 src-tauri/icons/icon.png \
            $out/share/icons/hicolor/256x256/apps/langloom.png

          runHook postInstall
        '';

        # Bake Wayland-safe WebKit flags into the wrapper.
        preFixup = ''
          gappsWrapperArgs+=(
            --set WEBKIT_DISABLE_DMABUF_RENDERER 1
            --set WEBKIT_DISABLE_COMPOSITING_MODE 1
          )
        '';
      };

      devShells.${system}.default = pkgs.mkShell {
        nativeBuildInputs = with pkgs; [ pkg-config ];
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
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtimeLibs;
        WEBKIT_DISABLE_DMABUF_RENDERER = "1";
        WEBKIT_DISABLE_COMPOSITING_MODE = "1";
      };
    };
}
