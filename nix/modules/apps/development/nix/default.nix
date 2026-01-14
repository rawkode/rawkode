_: {
  flake.homeModules.development-nix =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        nil
        nixfmt
      ];
    };
}
