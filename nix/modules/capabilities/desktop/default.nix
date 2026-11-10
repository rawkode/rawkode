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
      # nixpkgs pins github-copilot-app 1.1.29; take the upstream v1.1.35 .deb
      # for x86_64-linux until nixpkgs catches up. The aarch64-linux .deb keeps
      # the nixpkgs version because its hash is not pinned here.
      nixpkgs.overlays = lib.optionals (!isDarwin) [
        (_final: prev: {
          github-copilot-app =
            if prev.stdenv.hostPlatform.system == "x86_64-linux" then
              prev.github-copilot-app.overrideAttrs (old: {
                version = "1.1.35";
                src = prev.fetchurl {
                  url = "https://github.com/github/app/releases/download/v1.1.35/GitHub-Copilot-linux-x64.deb";
                  hash = "sha256-wsxvA4l0ezQsZL5WE7P/w/VuPb4dEdyC9JbmZaYTQE8=";
                };
                # libfoundry_local.so needs libonnxruntime.so.1, but the bundle ships
                # only libonnxruntime.so (whose SONAME is .so.1), so autoPatchelf
                # cannot resolve it without this alias.
                postInstall = (old.postInstall or "") + ''
                  ln -s libonnxruntime.so "$out/lib/GitHub Copilot/libonnxruntime.so.1"
                '';
              })
            else
              prev.github-copilot-app;
        })
      ];

      home.packages = lib.optionals (!isDarwin) (
        with llmAgents;
        [
          chatgpt
          claude-desktop
          hermes-desktop
          pkgs.github-copilot-app
        ]
      );

      # Keep Hermes' gateway under systemd so Desktop can attach to the wrapped
      # Nix CLI. Its unmanaged bootstrap starts bare sys.executable, which lacks
      # the Python dependencies supplied by the hermes-agent wrapper.
      systemd.user.services = lib.mkIf (!isDarwin) {
        hermes-gateway = {
          Unit.Description = "Hermes Agent gateway";
          Service = {
            # Listens on all interfaces; the NixOS firewall only admits the port
            # on the NetBird interface (see the nixos module below).
            Environment = [
              "API_SERVER_ENABLED=true"
              "API_SERVER_HOST=0.0.0.0"
            ];
            ExecStart = "${lib.getExe llmAgents.hermes-agent} gateway run --quiet";
            Restart = "on-failure";
            RestartSec = 5;
            # Optional file outside the repo that holds API_SERVER_KEY. The API
            # server does not start without a key of at least 16 characters.
            EnvironmentFile = "-%h/.config/hermes/api-server.env";
          };
          Install.WantedBy = [ "default.target" ];
        };
      };

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
          appBundles.rio.home
          appBundles.handy.home
          appBundles.onepassword.home
          appBundles.zed.home
        ]
        ++ lib.optionals (!isDarwin) [
          inputs.flatpaks.homeManagerModules.nix-flatpak

          appBundles.antarctical.home
          appBundles.chinstrap.home
          appBundles.eloquawk.home
          appBundles.firefox-nightly.home
          appBundles.flipper.home
          appBundles.rockhopper.home
          appBundles.sonora.home

          homeModules.dconf-editor
          homeModules.flatpak
          homeModules.desktop-defaults
          homeModules.dux
          homeModules.niri
          homeModules.noctalia
          homeModules.portals
          homeModules.rquickshare
          homeModules.umbriel
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
    inputs.self.nixosModules.fonts
    inputs.self.nixosModules.desktop-defaults
    inputs.self.nixosModules.location
    inputs.self.nixosModules.niri
    inputs.self.nixosModules.onepassword
    inputs.self.nixosModules.plymouth
    inputs.self.nixosModules.polkit
    inputs.self.nixosModules.portals
    inputs.self.nixosModules.rockhopper
    inputs.self.nixosModules.umbriel
    (_: {
      # Hermes API server (default port 8642) is reachable only over the NetBird
      # interface. Peer-level access is restricted by NetBird policies.
      networking.firewall.interfaces.wt0.allowedTCPPorts = [ 8642 ];
    })
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
    appBundles.rio.darwin
    appBundles.handy.darwin
    appBundles.onepassword.darwin
    appBundles.zed.darwin

    darwinModules.apps
    darwinModules.kree
  ];
}
