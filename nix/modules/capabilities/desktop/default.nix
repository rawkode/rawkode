{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "desktop";

  home =
    { isDarwin, ... }:
    {
      imports =
        with inputs.self;
        [
          appBundles.ghostty.home
          appBundles.wezterm.home
          appBundles.firefox-developer-edition.home
          appBundles.google-chrome.home
          appBundles.vivaldi.home
          appBundles.onepassword.home
          appBundles.lan-mouse.home
        ]
        ++ lib.optionals (!isDarwin) [
          inputs.flatpaks.homeManagerModules.nix-flatpak
          inputs.ironbar.homeManagerModules.default
          inputs.vicinae.homeManagerModules.default

          homeModules.dconf-editor
          homeModules.flatpak
          homeModules.gnome
          homeModules.ironbar
          homeModules.niri
          homeModules.portals
          homeModules.rquickshare
          homeModules.vicinae
          homeModules.wayland
        ];
    };

  nixos = [
    inputs.self.nixosModules.profiles-desktop
  ];

  darwin = with inputs.self; [
    appBundles.ghostty.darwin
    appBundles.wezterm.darwin
    appBundles.firefox-developer-edition.darwin
    appBundles.google-chrome.darwin
    appBundles.vivaldi.darwin
    appBundles.onepassword.darwin

    darwinModules.alt-tab
    darwinModules.ice
    darwinModules.kree
    darwinModules.raycast
  ];
}
