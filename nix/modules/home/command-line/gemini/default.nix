{ inputs, pkgs, ... }:
{
  home.packages = [
    inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.gemini-cli
  ];
}
