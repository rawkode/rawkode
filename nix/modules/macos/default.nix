{
  flake.darwinModules.apps =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [
          "finetune"
          "parallels"
          "raycast"
        ];
      };
    };
}
