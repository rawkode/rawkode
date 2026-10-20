{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
(mkApp {
  name = "waddle";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.waddle ];
    };
})
// {
  perSystem =
    { pkgs, lib, ... }:
    {
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        waddle = pkgs.rustPlatform.buildRustPackage {
          pname = "waddle-linux";
          version = "0.1.0";
          src = inputs.waddle;

          # Keep the monorepo source for the shared Rust crates in server/.
          cargoRoot = "apps/linux";
          buildAndTestSubdir = "apps/linux";
          cargoLock.lockFile = "${inputs.waddle}/apps/linux/Cargo.lock";

          nativeBuildInputs = with pkgs; [
            pkg-config
            blueprint-compiler
            wrapGAppsHook4
          ];
          buildInputs = with pkgs; [
            gtk4
            libadwaita
          ];

          # reqwest's platform verifier needs a trust store in sandboxed tests.
          env.SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

          postInstall = ''
            install -Dm644 apps/linux/data/social.waddle.Waddle.desktop \
              "$out/share/applications/social.waddle.Waddle.desktop"
            install -Dm644 apps/linux/data/social.waddle.Waddle.metainfo.xml \
              "$out/share/metainfo/social.waddle.Waddle.metainfo.xml"
            mkdir -p "$out/share/icons"
            cp -r apps/linux/data/icons/hicolor "$out/share/icons/"
          '';

          meta = {
            description = "Native GTK client for Waddle";
            homepage = "https://github.com/waddle-social/waddle";
            license = lib.licenses.agpl3Plus;
            mainProgram = "waddle-linux";
            platforms = lib.platforms.linux;
          };
        };
      };
    };
}
