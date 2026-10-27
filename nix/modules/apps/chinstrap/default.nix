{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "chinstrap";

  linux.home = {
    imports = [ inputs.chinstrap.homeModules.default ];

    programs.chinstrap = {
      enable = true;

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
