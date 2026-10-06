{
  description = "nueon — conlang editor and creation app";

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
        pname = "nueon-frontend";
        version = "0.1.0";
        src = ./.;
        npmDepsHash = "sha256-WL8pPVoCNKpEvTE1MztX75cOx31FkMzRImXPd46qI2E=";
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
      packages.${system} = {
        default = pkgs.rustPlatform.buildRustPackage {
        pname = "nueon";
        version = "0.1.0";
        src = ./.;
        cargoLock.lockFile = ./Cargo.lock;

        # Build the Tauri app with the production `custom-protocol` feature so
        # `generate_context!` embeds the built frontend instead of pointing at
        # the Vite dev server (http://localhost:1420).
        cargoBuildFlags = [
          "-p"
          "nueon-tauri"
          "--features"
          "custom-protocol"
        ];

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
            "$(find target -type f -name nueon -path '*/release/nueon' -print -quit)" \
            $out/bin/nueon

          install -Dm644 ${./packaging/nueon.desktop} \
            $out/share/applications/nueon.desktop

          install -Dm644 src-tauri/icons/32x32.png \
            $out/share/icons/hicolor/32x32/apps/nueon.png
          install -Dm644 src-tauri/icons/128x128.png \
            $out/share/icons/hicolor/128x128/apps/nueon.png
          install -Dm644 src-tauri/icons/icon.png \
            $out/share/icons/hicolor/256x256/apps/nueon.png

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

        # Precompiled binary fetched from a GitHub release .deb and patched for
        # Nix. Update `version` and refresh `hash` after publishing a release:
        #   nix-prefetch-url --type sha256 <the deb url below>
        nueon-bin = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "nueon-bin";
        version = "0.1.0";
        src = pkgs.fetchurl {
          url = "https://github.com/y-jar/nueon/releases/download/v${finalAttrs.version}/nueon_${finalAttrs.version}_amd64.deb";
          hash = pkgs.lib.fakeHash;
        };
        nativeBuildInputs = with pkgs; [
          dpkg
          autoPatchelfHook
          makeWrapper
        ];
        buildInputs = runtimeLibs;
        unpackPhase = ''
          runHook preUnpack
          dpkg-deb -x $src .
          runHook postUnpack
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -r usr/. $out/
          # Same Wayland-safe WebKit flags as the source build.
          wrapProgram $out/bin/nueon \
            --set WEBKIT_DISABLE_DMABUF_RENDERER 1 \
            --set WEBKIT_DISABLE_COMPOSITING_MODE 1
          runHook postInstall
        '';
        });
      };

      # Single source of truth: shell.nix defines the dev environment, tools,
      # and `loom-*` commands (also reachable through short aliases in-shell).
      devShells.${system}.default = import ./shell.nix { inherit pkgs; };
    };
}
