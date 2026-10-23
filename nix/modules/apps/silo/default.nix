{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
(mkApp {
  name = "silo";

  linux.home =
    {
      lib,
      pkgs,
      ...
    }:
    let
      silo = inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.silo;
    in
    {
      home.packages = [ silo ];

      xdg.mimeApps = {
        enable = true;
        defaultApplications = {
          "x-scheme-handler/http" = lib.mkForce [ "com.nofaff.Silo.desktop" ];
          "x-scheme-handler/https" = lib.mkForce [ "com.nofaff.Silo.desktop" ];
        };
      };

      home.file.".mozilla/native-messaging-hosts/com.nofaff.silo.json".source =
        "${silo}/share/mozilla/native-messaging-hosts/com.nofaff.silo.json";
    };
})
// {
  perSystem =
    {
      pkgs,
      lib,
      ...
    }:
    let
      runtimeInputs = with pkgs; [
        coreutils
        desktop-file-utils
        gtk3
        xdg-utils
      ];
    in
    {
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        silo = pkgs.rustPlatform.buildRustPackage (finalAttrs: {
          pname = "silo";
          version = "1.2.0";

          src = pkgs.fetchFromGitHub {
            owner = "no-faff";
            repo = "Silo";
            rev = "v${finalAttrs.version}";
            hash = "sha256-nexpNL3kcDsFD/zSKfQFCvLc3vYUV2MA7aS4bqa4jVQ=";
          };
          cargoLock.lockFile = "${finalAttrs.src}/Cargo.lock";
          cargoBuildFlags = [
            "--package"
            "silo"
          ];

          nativeBuildInputs = with pkgs; [
            makeWrapper
            pkg-config
            python3
            wrapGAppsHook4
          ];
          buildInputs = with pkgs; [
            gtk4
            libadwaita
          ];

          dontWrapGApps = true;

          postInstall = ''
            install -Dm644 data/com.nofaff.Silo.desktop \
              "$out/share/applications/com.nofaff.Silo.desktop"
            substituteInPlace "$out/share/applications/com.nofaff.Silo.desktop" \
              --replace-fail 'Exec=silo %u' "Exec=$out/bin/silo %u"

            mkdir -p "$out/share/icons"
            cp -r data/icons/hicolor "$out/share/icons/"

            install -Dm644 LICENSE "$out/share/licenses/silo/LICENSE"

            install -Dm755 native-host/silo-host.py "$out/libexec/silo/silo-host.py"
            substituteInPlace "$out/libexec/silo/silo-host.py" \
              --replace-fail '#!/usr/bin/env python3' '#!${pkgs.python3}/bin/python3' \
              --replace-fail 'fallback = os.path.expanduser("~/.local/bin/silo")' \
              "fallback = \"$out/bin/silo\""

            install -Dm644 native-host/com.nofaff.silo.firefox.json \
              "$out/share/mozilla/native-messaging-hosts/com.nofaff.silo.json"
            substituteInPlace \
              "$out/share/mozilla/native-messaging-hosts/com.nofaff.silo.json" \
              --replace-fail SILO_HOST_PATH "$out/libexec/silo/silo-host.py"
          '';

          postFixup = ''
            wrapProgram "$out/bin/silo" \
              "''${gappsWrapperArgs[@]}" \
              --prefix PATH : "${lib.makeBinPath runtimeInputs}"
          '';

          meta = {
            description = "GTK browser and profile picker for Linux";
            homepage = "https://github.com/no-faff/Silo";
            license = lib.licenses.mit;
            mainProgram = "silo";
            platforms = lib.platforms.linux;
          };
        });
      };
    };
}
