{ inputs, pkgs, ... }:
{
  home.packages = (
    with pkgs;
    [
      inputs.dagger.packages.${system}.dagger

      aichat
      just
      nil
      nixfmt-rfc-style
      rquickshare
      slack
      vesktop
      zoom-us
      zoxide
    ]
  );
}
