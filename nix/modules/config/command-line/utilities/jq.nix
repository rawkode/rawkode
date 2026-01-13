{
  flake.homeModules.jq =
    # jq - Command-line JSON processor
    {
      pkgs,
      ...
    }:

    {
      home.packages = with pkgs; [
        jq
      ];
    };
}
