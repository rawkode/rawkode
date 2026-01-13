{
  flake.homeModules.zoom =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.zoom-us ];
    };
}
