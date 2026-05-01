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
          appBundles.forklift.home
          appBundles.google-chrome.home
          appBundles.vivaldi.home
          appBundles.onepassword.home
          appBundles.deskflow.home
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
    inputs.self.nixosModules.audio
    inputs.self.nixosModules.bluetooth
    inputs.self.nixosModules.desktop-common
    inputs.self.nixosModules.flatpak
    inputs.self.nixosModules.firefox-developer-edition
    inputs.self.nixosModules.fonts
    inputs.self.nixosModules.gnome
    inputs.self.nixosModules.google-chrome
    inputs.self.nixosModules.location
    inputs.self.nixosModules.niri
    inputs.self.nixosModules.onepassword
    inputs.self.nixosModules.plymouth
    inputs.self.nixosModules.polkit
    inputs.self.nixosModules.portals
    (_: {
      services = {
        pipewire = {
          enable = true;
          alsa.enable = true;
          pulse.enable = true;
        };
        printing.enable = true;
      };
    })
  ];

  darwin = with inputs.self; [
    appBundles.ghostty.darwin
    appBundles.wezterm.darwin
    appBundles.firefox-developer-edition.darwin
    appBundles.forklift.darwin
    appBundles.google-chrome.darwin
    appBundles.vivaldi.darwin
    appBundles.onepassword.darwin
    appBundles.deskflow.darwin

    darwinModules.apps
    darwinModules.kree
  ];
}
