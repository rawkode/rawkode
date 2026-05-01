{
  flake.darwinModules.apps =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [
          "alt-tab"
          "dockdoor"
          "finetune"
          "jordanbaird-ice"
          "parallels"
          "raycast"
        ];
      };
    };
}
