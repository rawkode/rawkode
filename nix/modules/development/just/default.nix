{
  flake.homeModules.just =
    {
      pkgs,
      ...
    }:
    {
      home.packages = with pkgs; [
        just
      ];
    };
}
