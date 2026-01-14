{
  flake.homeModules.lazyjournal =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        lazyjournal
      ];
    };
}
