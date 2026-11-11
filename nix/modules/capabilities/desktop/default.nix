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
                # nixpkgs' patchelf (0.15.x) rewrites one R_X86_64_RELATIVE entry as
                # R_X86_64_PLT32 when it changes the interpreter or RPATH of this
                # executable, and ld.so aborts on startup ("Inconsistency detected").
                # The executable is therefore left unpatched and started through the
                # glibc loader with an explicit library path. Shared libraries are
                # still patched so their own dependencies resolve.
                dontAutoPatchelf = true;
                # wrapGAppsHook also wraps libexec/, which would turn the executable
                # into a wrapper that execs it directly and hits the stub loader, so
                # the GApps environment is applied to the launcher script only.
                dontWrapGApps = true;
                postFixup = (old.postFixup or "") + ''
                  autoPatchelf "$out/lib"

                  mkdir -p "$out/libexec"
                  mv "$out/bin/github-copilot-app" "$out/libexec/github-copilot-app"
                  cat > "$out/bin/github-copilot-app" <<EOF
                  #!${prev.runtimeShell}
                  exec ${prev.stdenv.cc.libc}/lib/ld-linux-x86-64.so.2 --library-path "${
                    lib.makeLibraryPath (old.buildInputs ++ [ prev.stdenv.cc.libc ])
                  }:$out/lib/GitHub Copilot" "$out/libexec/github-copilot-app" "\$@"
                  EOF
                  chmod +x "$out/bin/github-copilot-app"
                  wrapProgram "$out/bin/github-copilot-app" "''${gappsWrapperArgs[@]}"
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
            ExecStart = "${lib.getExe llmAgents.hermes-agent} gateway run --quiet";
            Restart = "on-failure";
            RestartSec = 5;
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
    inputs.self.nixosModules.onepassword
    inputs.self.nixosModules.plymouth
    inputs.self.nixosModules.polkit
    inputs.self.nixosModules.portals
    inputs.self.nixosModules.rockhopper
    inputs.self.nixosModules.umbriel
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
