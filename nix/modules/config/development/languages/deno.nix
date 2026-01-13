_: {
  flake.homeModules.development-deno =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ deno ];
      home.sessionPath = [ "$HOME/.deno/bin" ];
    };
}
