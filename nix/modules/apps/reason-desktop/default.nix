{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
(mkApp {
  name = "reason-desktop";

  linux.home =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals (pkgs.stdenv.hostPlatform.system == "x86_64-linux") [
        inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.reason-desktop
      ];
    };
})
// {
  perSystem =
    { pkgs, lib, ... }:
    let
      reasonPkgs = import inputs.nixpkgs {
        inherit (pkgs.stdenv.hostPlatform) system;
        config.allowUnfreePredicate = package: lib.getName package == "reason-desktop";
      };
      version = "0.1.115";
      src = reasonPkgs.fetchurl {
        name = "Reason-${version}-x86_64.AppImage";
        # Upstream only exposes the latest release through this endpoint.
        # Update the version and hash together when it changes.
        url = "https://reasonmachines.com/api/desktop-download?os=linux&arch=x64&package=appimage";
        hash = "sha256-wl9/r9X/2uIPwSOlrH+FR9MS41dUX1g6nS3UbaCZ/DY=";
      };
      contents = reasonPkgs.appimageTools.extract {
        pname = "reason-desktop";
        inherit version src;
        postExtract = ''
          # The application must not treat the Nix store as a mutable AppImage.
          substituteInPlace "$out/AppRun" \
            --replace-fail 'exec "$BIN" "''${NO_SANDBOX[@]}"' \
              'exec env -u APPDIR "$BIN" "''${NO_SANDBOX[@]}"'
        '';
      };
    in
    {
      packages = lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
        reason-desktop = reasonPkgs.appimageTools.wrapAppImage {
          pname = "reason-desktop";
          inherit version src contents;

          nativeBuildInputs = [ reasonPkgs.makeWrapper ];
          extraPkgs = pkgs: [ pkgs.util-linux ];

          extraInstallCommands = ''
            install -Dm444 ${contents}/reason-desktop.desktop \
              "$out/share/applications/reason-desktop.desktop"
            substituteInPlace "$out/share/applications/reason-desktop.desktop" \
              --replace-fail 'Exec=AppRun %U' "Exec=$out/bin/reason-desktop %U"
            install -Dm444 ${contents}/usr/share/icons/hicolor/512x512/apps/reason-desktop.png \
              "$out/share/icons/hicolor/512x512/apps/reason-desktop.png"

            # Reason uses APPIMAGE for its autostart command. A command on PATH
            # survives Nix upgrades, while the patched AppRun disables its updater.
            wrapProgram "$out/bin/reason-desktop" --set APPIMAGE reason-desktop
          '';

          meta = {
            description = "Reason Machines desktop application";
            homepage = "https://reasonmachines.com/";
            license = lib.licenses.unfree;
            mainProgram = "reason-desktop";
            platforms = [ "x86_64-linux" ];
          };
        };
      };
    };
}
