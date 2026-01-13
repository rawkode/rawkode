{
  flake.homeModules.development-moon =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ moon ];
    };
}
