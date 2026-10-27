{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "desktop";

  home =
    {
      isDarwin,
      lib,
      pkgs,
      ...
    }:
    let
      llmAgents = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
    in
    {
      home.packages = lib.optionals (!isDarwin) (
        with llmAgents;
        [
          chatgpt
          claude-desktop
        ]
      );

      # The desktop launcher may not inherit NIXOS_OZONE_WL from the session.
      xdg.dataFile."applications/chatgpt.desktop" = lib.mkIf (!isDarwin) {
        source = pkgs.runCommand "chatgpt-wayland.desktop" { } ''
          substitute ${llmAgents.chatgpt}/share/applications/chatgpt.desktop "$out" \
            --replace-fail 'Exec=chatgpt %U' 'Exec=${lib.getExe llmAgents.chatgpt} --ozone-platform=wayland %U'
        '';
      };

      imports =
        with inputs.self;
        [
          appBundles.ghostty.home
          appBundles.google-chrome.home
          appBundles.handy.home
          appBundles.onepassword.home
          appBundles.zed.home
        ]
        ++ lib.optionals (!isDarwin) [
          inputs.flatpaks.homeManagerModules.nix-flatpak

          appBundles.antarctical.home
          appBundles.chinstrap.home
          appBundles.firefox-nightly.home
          appBundles.flipper.home
          appBundles.rockhopper.home
          appBundles.sonora.home

          homeModules.dconf-editor
          homeModules.flatpak
          homeModules.gnome
          homeModules.dank-material-shell
          homeModules.niri
          homeModules.portals
          homeModules.rquickshare
          homeModules.wayland
        ];
    };

  nixos = [
    inputs.flatpaks.nixosModules.nix-flatpak
    inputs.self.nixosModules.antarctical
    inputs.self.nixosModules.audio
    inputs.self.nixosModules.bluetooth
    inputs.self.nixosModules.chinstrap
    inputs.self.nixosModules.desktop-common
    inputs.self.nixosModules.greetd
    inputs.self.nixosModules.flatpak
    inputs.self.nixosModules.firefox-nightly
    inputs.self.nixosModules.google-chrome
    inputs.self.nixosModules.fonts
    inputs.self.nixosModules.gnome
    inputs.self.nixosModules.location
    inputs.self.nixosModules.niri
    inputs.self.nixosModules.onepassword
    inputs.self.nixosModules.plymouth
    inputs.self.nixosModules.polkit
    inputs.self.nixosModules.portals
    inputs.self.nixosModules.rockhopper
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
    appBundles.firefox-nightly.darwin
    appBundles.ghostty.darwin
    appBundles.google-chrome.darwin
    appBundles.handy.darwin
    appBundles.onepassword.darwin
    appBundles.zed.darwin

    darwinModules.apps
    darwinModules.kree
  ];
}
