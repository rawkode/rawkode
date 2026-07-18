{
  flake.darwinModules.apps =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        taps = [ "Sanyam-G/switch" ];
        casks = [
          "bartender"
          "finetune"
          "iina"
          "raycast"
          "Sanyam-G/switch/switch"
        ];
      };
    };
}
