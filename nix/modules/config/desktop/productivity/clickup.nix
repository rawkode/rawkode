{
  flake.homeModules.clickup =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        clickup
      ];
    };
}
