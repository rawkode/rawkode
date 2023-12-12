{ pkgs }:

{
  program.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };
}
