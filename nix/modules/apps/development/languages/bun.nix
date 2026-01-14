_: {
  flake.homeModules.development-bun =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ bun ];
      home.sessionPath = [
        "/home/rawkode/.cache/.bun/bin"
      ];
    };
}
