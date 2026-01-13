{
  flake.homeModules.cue =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        cue
      ];
    };
}
