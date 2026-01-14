{
  flake.homeModules.gnome-burn-my-windows =
    { pkgs, ... }:
    let
      burnMyWindowsProfile = pkgs.writeText "burn-my-windows.conf" ''
        [burn-my-windows-profile]
        profile-window-type=1
        profile-animation-type=2
        fire-enable-effect=false
        wisps-enable-effect=true
      '';
    in
    {
      dconf.settings = {
        "org/gnome/shell" = {
          enabled-extensions = [ "burn-my-windows@schneegans.github.com" ];
        };
        "org/gnome/shell/extensions/burn-my-windows" = {
          active-profile = "${burnMyWindowsProfile}";
        };
      };

      home.packages = with pkgs.gnomeExtensions; [ burn-my-windows ];
    };
}
