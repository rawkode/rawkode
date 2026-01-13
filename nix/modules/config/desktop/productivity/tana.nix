{
  flake.homeModules.tana =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ tana ];
    };
}
