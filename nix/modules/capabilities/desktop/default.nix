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
          appBundles.handy.home
          appBundles.onepassword.home
          appBundles.zed.home
        ]
        ++ lib.optionals (!isDarwin) [
          inputs.flatpaks.homeManagerModules.nix-flatpak

          appBundles.antarctical.home
          appBundles.chinstrap.home
          appBundles.eloquawk.home
          appBundles.flipper.home
          appBundles.github-copilot-app.home
          appBundles.google-chrome-dev.home
          appBundles.rockhopper.home
          appBundles.sonora.home

          homeModules.dconf-editor
          homeModules.flatpak
          homeModules.desktop-defaults
          homeModules.noctalia
          homeModules.rquickshare
          homeModules.umbriel
          homeModules.wayland
        ];
    };

  nixos = [
    inputs.flatpaks.nixosModules.nix-flatpak
    inputs.self.nixosModules.audio
    inputs.self.nixosModules.bluetooth
    inputs.self.nixosModules.desktop-common
    inputs.self.nixosModules.greetd
    inputs.self.nixosModules.flatpak
    inputs.self.nixosModules.fonts
    inputs.self.nixosModules.desktop-defaults
    inputs.self.nixosModules.location
    inputs.self.nixosModules.noctalia
    inputs.self.nixosModules.onepassword
    inputs.self.nixosModules.plymouth
    inputs.self.nixosModules.polkit
    inputs.self.nixosModules.portals
    inputs.self.nixosModules.rquickshare
    inputs.self.nixosModules.umbriel
    inputs.self.nixosModules.wayland
    (_: {
      services.printing.enable = true;
    })
  ];

  darwin = with inputs.self; [
    appBundles.google-chrome-dev.darwin
    appBundles.handy.darwin
    appBundles.onepassword.darwin
    appBundles.zed.darwin

    darwinModules.apps
    darwinModules.kree
  ];
}
