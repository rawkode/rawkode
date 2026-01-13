_: {
  flake.homeModules.development-distrobox =
    { pkgs, lib, ... }:
    let
      linuxOnly = pkgs.stdenv.isLinux;
    in
    {
      home.packages = lib.optionals linuxOnly (with pkgs; [
        boxbuddy
        distrobox
        toolbox
      ]);
    };
}
