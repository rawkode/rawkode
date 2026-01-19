{
  flake.homeModules.nh =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.nh ];
    };
}
