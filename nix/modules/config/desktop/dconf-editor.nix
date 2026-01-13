{
  flake.homeModules.dconf-editor =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.dconf-editor ];
    };
}
