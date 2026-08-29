_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "github";

  common.home = _: {
    programs.gh = {
      enable = true;

      settings = {
        git_protocol = "ssh";
        prompt = "enabled";
      };
    };
  };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [
          "copilot-cli@prerelease"
        ];
      };
    };
}
