{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "hex";

  linux.home =
    { config, lib, ... }:
    {
      imports = [ inputs.hex.homeManagerModules.hex ];

      programs.hex = {
        enable = true;
        autostart = true;
      };

      programs.niri.settings.binds."Super+D" = {
        hotkey-overlay.title = "Toggle voice dictation";
        repeat = false;
        action.spawn = [
          (lib.getExe config.programs.hex.package)
          "dictation"
          "toggle"
        ];
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        taps = [ "anomalyco/tap" ];
        casks = [ "anomalyco/tap/hex" ];
      };
    };
}
