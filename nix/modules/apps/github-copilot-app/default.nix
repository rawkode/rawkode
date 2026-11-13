_:
let
  mkApp = import ../../../lib/mkApp.nix;

  # The nixpkgs package repackages the upstream .deb and patchelfs the Tauri
  # binary, which does not start reliably on NixOS. Running the official
  # AppImage inside appimageTools' FHS environment avoids patching the binary.
  version = "1.4.0";
  sources = {
    x86_64-linux = {
      arch = "x64";
      hash = "sha256-g/R6BIgFdCZbLk9NQ0oUcfr2VIRYm9FDoyQ+qGNV0Dc=";
    };
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-GCjA3CZK5gGad016HVoS+dV2ollNjS2XpZsEfWVDKg0=";
    };
  };

  mkPackage =
    {
      lib,
      stdenv,
      fetchurl,
      appimageTools,
      makeDesktopItem,
    }:
    let
      pname = "github-copilot-app";
      source = sources.${stdenv.hostPlatform.system};
      src = fetchurl {
        url = "https://github.com/github/app/releases/download/v${version}/GitHub-Copilot-linux-${source.arch}.AppImage";
        inherit (source) hash;
      };
      contents = appimageTools.extract { inherit pname version src; };
      # Mirrors the .desktop file shipped inside the AppImage, pointed at the
      # wrapper instead of the bundled binary name.
      desktopItem = makeDesktopItem {
        name = pname;
        exec = "${pname} %u";
        icon = pname;
        desktopName = "GitHub Copilot";
        comment = "GitHub Copilot desktop application";
        categories = [ "Development" ];
        startupWMClass = "github";
        mimeTypes = [
          "x-scheme-handler/github-app"
          "x-scheme-handler/ghapp"
          "x-scheme-handler/gh"
        ];
      };
    in
    appimageTools.wrapType2 {
      inherit pname version src;

      # Libraries the bundled ones link against but expect from the host, and
      # that appimageTools' default FHS environment does not provide.
      extraPkgs = pkgs: [
        pkgs.e2fsprogs # libcom_err
        pkgs.gmp
        pkgs.libgpg-error
      ];

      extraInstallCommands = ''
        for size in 32x32 128x128 256x256@2; do
          install -Dm644 "${contents}/usr/share/icons/hicolor/$size/apps/github.png" \
            "$out/share/icons/hicolor/$size/apps/${pname}.png"
        done
        install -Dm644 -t "$out/share/applications" ${desktopItem}/share/applications/*.desktop
      '';

      meta = {
        description = "GitHub Copilot desktop application";
        homepage = "https://github.com/github/app";
        license = lib.licenses.unfree;
        sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
        platforms = builtins.attrNames sources;
        mainProgram = pname;
      };
    };
in
mkApp {
  name = "github-copilot-app";

  linux.home =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optional (sources ? ${pkgs.stdenv.hostPlatform.system}) (
        pkgs.callPackage mkPackage { }
      );
    };
}
