{ inputs, lib, namespace, pkgs, ... }:
with lib;
with lib.${namespace};
{
  home.packages = (
    with pkgs;
    [
      rawkOS.browsers

      inputs.dagger.packages.${system}.dagger
      inputs.fluentci.packages.${system}.default

      aichat
      just
      nil
      nixfmt-rfc-style
      zoxide
    ]
  );
}
