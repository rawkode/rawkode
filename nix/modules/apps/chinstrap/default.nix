{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "chinstrap";

  linux.home = { pkgs, ... }: {
    imports = [ inputs.chinstrap.homeModules.default ];

    programs.chinstrap = {
      enable = true;

      # Storage tests start GStreamer device monitors that share process-wide providers.
      package = inputs.chinstrap.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (old: {
        env = (old.env or { }) // {
          RUST_TEST_THREADS = "1";
        };
      });

      settings = {
        # Skip language detection; every take is in English.
        whisper_lang = "en";
      };

      # Managed here, so the Vocabulary panel cannot edit them; add terms and rules below.
      glossary = [
        "Rawkode"
        "Rawkode Academy"
        "Kubernetes"
        "kubectl"
      ];

      replacements = {
        "raw code" = "Rawkode";
        "Rawko" = "Rawkode";
        "Rockhold" = "Rawkode";
        "cube control" = "kubectl";
      };
    };
  };
}
