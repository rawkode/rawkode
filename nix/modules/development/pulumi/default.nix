{
  flake.homeModules.pulumi =
    {
      pkgs,
      ...
    }:
    {
      home.packages = with pkgs; [ pulumi-bin ];
    };
}
