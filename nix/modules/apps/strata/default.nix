{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
(mkApp {
  name = "strata";
  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.strata ];
    };
})
// {
  perSystem =
    { pkgs, lib, ... }:
    let
      helpers = with pkgs; [
        bubblewrap
        coreutils
        util-linux
        ffmpeg
        ffmpegthumbnailer
        imagemagick
        libraw
        squashfsTools
        xdg-utils
      ];
    in
    {
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        strata = pkgs.rustPlatform.buildRustPackage (finalAttrs: {
          pname = "strata";
          version = "1.1.0";

          src = pkgs.fetchzip {
            url = "https://github.com/lgse/strata/archive/refs/tags/v${finalAttrs.version}.tar.gz";
            hash = "sha256-FoYYsjvWY+1SuZtvxancdVR6h7iFmnbtHXW2eTlVCJI=";
          };
          cargoLock.lockFile = "${finalAttrs.src}/Cargo.lock";

          # Upstream's default RAR feature embeds non-free UnRAR.
          buildNoDefaultFeatures = true;
          nativeBuildInputs = with pkgs; [
            pkg-config
            glib
            wrapGAppsHook4
          ];
          buildInputs = with pkgs; [
            gtk4
            gtksourceview5
            poppler
            fontconfig
            gst_all_1.gstreamer
            gst_all_1.gst-plugins-base
            gst_all_1.gst-plugins-good
            gst_all_1.gst-plugins-bad
            gst_all_1.gst-libav
          ];

          # Both the host and isolated preview helpers need immutable Nix paths.
          env = {
            STRATA_RELEASE_TAG = "v${finalAttrs.version}";
            STRATA_TRUSTED_COMMAND_PATH = lib.makeBinPath helpers;
            STRATA_SANDBOX_PATH = lib.makeBinPath helpers;
            STRATA_SANDBOX_ROOT = "/nix/store";
            STRATA_SANDBOX_PRLIMIT = lib.getExe' pkgs.util-linux "prlimit";
            STRATA_SANDBOX_GDK_PIXBUF_MODULE_FILE = "${pkgs.gdk-pixbuf}/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache";
          };

          # Upstream tests exercise desktop services and sandbox namespaces.
          doCheck = false;
          postInstall = ''
            install -Dm644 data/io.github.lgse.Strata.desktop \
              "$out/share/applications/io.github.lgse.Strata.desktop"
            substituteInPlace "$out/share/applications/io.github.lgse.Strata.desktop" \
              --replace-fail 'Exec=strata' "Exec=$out/bin/strata"
            install -Dm644 data/icons/scalable/apps/io.github.lgse.Strata.svg \
              "$out/share/icons/hicolor/scalable/apps/io.github.lgse.Strata.svg"
            mkdir -p "$out/share/strata"
            cat > "$out/share/strata/install-source.toml" <<EOF
            manager = "nix"
            package = "strata"
            channel = "stable"
            EOF
          '';

          meta = {
            description = "Keyboard-first GTK file manager for Linux";
            homepage = "https://github.com/lgse/strata";
            license = lib.licenses.mit;
            mainProgram = "strata";
            platforms = lib.platforms.linux;
          };
        });
      };
    };
}
