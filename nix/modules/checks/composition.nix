{ inputs, lib, ... }:
let
  resolver = import ../../lib/capabilityResolver.nix { inherit inputs; };
  fixtureManifest = capabilities: {
    platform = "nixos";
    system = "x86_64-linux";
    primaryUser = "fixture";
    users.fixture = { };
    inherit capabilities;
    disabledCapabilities = [ ];
    traits = [ ];
    modules = [
      {
        boot.isContainer = true;
        networking.useHostResolvConf = false;
        fileSystems."/" = {
          device = "none";
          fsType = "tmpfs";
        };
      }
    ];
  };
  fixtureManifests = {
    foundation-fixture = fixtureManifest [ "foundation" ];
    development-fixture = fixtureManifest [
      "foundation"
      "development"
    ];
    stylix-disabled-fixture =
      let
        base = fixtureManifest [
          "foundation"
          "development"
          "theming"
        ];
      in
      base
      // {
        modules = base.modules ++ [ ({ lib, ... }: { stylix.enable = lib.mkForce false; }) ];
      };
    stylix-no-auto-import-fixture =
      let
        base = fixtureManifest [
          "foundation"
          "development"
          "theming"
        ];
      in
      base
      // {
        modules = base.modules ++ [ { stylix.homeManagerIntegration.autoImport = false; } ];
      };
  };
  fixtureInputs = inputs // {
    self = inputs.self // {
      machineManifests = fixtureManifests;
      nixosModules = inputs.self.nixosModules // fixtureUser.flake.nixosModules;
    };
  };
  fixtureUser =
    (import ../../lib/mkUser.nix {
      inputs = fixtureInputs;
      inherit lib;
    })
      {
        username = "fixture";
        email = "fixture@example.invalid";
        preferences.editor = "vim";
      };
  fixtures =
    (import ../../lib/mkMachine.nix {
      inputs = fixtureInputs;
      inherit lib;
    }).mkMachines
      {
        manifests = fixtureManifests;
      };

  headless =
    c:
    !(
      c.services.greetd.enable
      || c.services.printing.enable
      || c.services.libinput.enable
      || c.services.fwupd.enable
      || c.services.hardware.bolt.enable
      || c.services.pcscd.enable
      || c.services.smartd.enable
      || c.services.flatpak.enable
      || c.services.pipewire.enable
      || c.programs.kdeconnect.enable
      || c.networking.wireless.iwd.enable
      || c.security.tpm2.enable
      || (c.stylix.enable or false)
    );

  orb = inputs.self.nixosConfigurations.p4x-orb-nixos.config;
  orbHome = orb.home-manager.users.rawkode;
  orbStandalone = inputs.self.homeConfigurations."rawkode@p4x-orb-nixos".config;
  orbPreferences = h: {
    editor = h.home.sessionVariables.EDITOR;
    ai = h.rawkOS.apps.ai.cliPackages.enable;
    python = h.rawkOS.development.python.extraTools.enable;
    ffmpeg = h.rawkOS.apps.misc.ffmpeg.enable;
    themed = h.stylix.enable or false;
  };
  graphicalMachines = lib.filterAttrs (
    machine: _: builtins.elem "desktop" (resolver.resolveMachineCapabilityNames { inherit machine; })
  ) inputs.self.machineManifests;
  graphicalNixos = lib.filterAttrs (
    machine: _: graphicalMachines ? ${machine}
  ) inputs.self.nixosConfigurations;

  graphical =
    c:
    c.services.greetd.enable
    && c.services.printing.enable
    && c.services.libinput.enable
    && c.services.flatpak.enable
    && c.services.pipewire.enable
    && c.programs.kdeconnect.enable
    && c.stylix.enable
    && lib.all (h: h.stylix.enable) (builtins.attrValues c.home-manager.users);
  multipass =
    c:
    if c ? fileSystems then
      lib.all (h: lib.any (p: lib.getName p == "multipass") h.home.packages) (
        builtins.attrValues c.home-manager.users
      )
      && lib.any (p: lib.hasInfix "70-multipass-mx4.rules" (toString p)) c.services.udev.packages
    else
      c.rawkOS.darwin.codeSigning.apps ? "Multipass.app";

  contract =
    assert lib.assertMsg (lib.all (v: headless v.config) [
      fixtures.nixosConfigurations.foundation-fixture
      fixtures.nixosConfigurations.development-fixture
    ]) "Foundation and foundation+development must be headless without service-disable overrides";
    assert lib.assertMsg (lib.all (v: !v.config.home-manager.users.fixture.home.pointerCursor.enable) [
      fixtures.nixosConfigurations.stylix-disabled-fixture
      fixtures.nixosConfigurations.stylix-no-auto-import-fixture
    ]) "A home without upstream Stylix integration must not enable an unconfigured cursor";
    assert lib.assertMsg (
      !fixtures.nixosConfigurations.foundation-fixture.config.virtualisation.podman.enable
    ) "Foundation must not enable the development container stack";
    assert lib.assertMsg
      fixtures.nixosConfigurations.development-fixture.config.virtualisation.podman.enable
      "Development must provide the container stack";
    assert lib.assertMsg (headless orb) "OrbStack must remain headless";
    assert lib.assertMsg (lib.all (v: graphical v.config) (
      builtins.attrValues graphicalNixos
    )) "Graphical NixOS hosts must retain desktop services and integrated theming";
    assert lib.assertMsg (lib.all (v: multipass v.config) (
      builtins.attrValues inputs.self.nixosConfigurations
      ++ builtins.attrValues inputs.self.darwinConfigurations
    )) "Every host must retain Multipass packages and platform integration";
    assert lib.assertMsg (
      orbPreferences orbHome == orbPreferences orbStandalone
    ) "OrbStack's integrated and standalone Home Manager preferences must agree";
    assert lib.assertMsg (
      orbPreferences orbHome == {
        editor = "vim";
        ai = false;
        python = false;
        ffmpeg = false;
        themed = false;
      }
    ) "OrbStack must retain its lightweight home preferences";
    assert lib.assertMsg (
      orb.environment.variables.EDITOR == orbHome.home.sessionVariables.EDITOR
    ) "The primary user's editor must also configure the system environment";
    assert lib.assertMsg (lib.all (
      machine:
      builtins.elem "peripherals-multipass" (resolver.resolveMachineCapabilityNames { inherit machine; })
    ) (builtins.attrNames inputs.self.machineManifests)) "All existing hosts must retain Multipass";
    true;

  # Force each complete system/activation derivation, including other platforms.
  # Discard string contexts only after evaluation: these are evaluation records,
  # not build dependencies on Linux systems from a Darwin check (or vice versa).
  evaluations = {
    nixos = lib.mapAttrs (_: v: v.config.system.build.toplevel.drvPath) inputs.self.nixosConfigurations;
    darwin = lib.mapAttrs (_: v: v.system.drvPath) inputs.self.darwinConfigurations;
    homes = lib.mapAttrs (_: v: v.activationPackage.drvPath) inputs.self.homeConfigurations;
    fixtures = lib.mapAttrs (_: v: v.config.system.build.toplevel.drvPath) fixtures.nixosConfigurations;
  };
  publicMachines = lib.filterAttrs (
    machine: _:
    !(builtins.elem "capabilities-coreweave" (
      resolver.resolveMachineCapabilityNames { inherit machine; }
    ))
  ) inputs.self.machineManifests;
  publicHomes = lib.concatLists (
    lib.mapAttrsToList (
      machine: manifest: map (username: "${username}@${machine}") (builtins.attrNames manifest.users)
    ) publicMachines
  );
  publicEvaluations = evaluations // {
    nixos = lib.filterAttrs (machine: _: publicMachines ? ${machine}) evaluations.nixos;
    darwin = lib.filterAttrs (machine: _: publicMachines ? ${machine}) evaluations.darwin;
    homes = lib.filterAttrs (home: _: builtins.elem home publicHomes) evaluations.homes;
  };
in
{
  # Explicit full-fleet evaluation for authenticated work environments.
  flake.machineEvaluations = evaluations;
  perSystem = { pkgs, ... }: {
    checks.fish-editor =
      let
        orbEditor =
          pkgs.writeText "orb-editor.fish"
            orbHome.xdg.configFile."fish/conf.d/rawkos-editor.fish".text;
        studioEditor =
          pkgs.writeText "studio-editor.fish"
            inputs.self.darwinConfigurations.p4x-studio.config.home-manager.users.rawkode.xdg.configFile."fish/conf.d/rawkos-editor.fish".text;
        verify = pkgs.writeText "verify-editor.fish" ''
          for name in EDITOR VISUAL SUDO_EDITOR SYSTEMD_EDITOR
            set --erase --global $name
            set --universal --export $name stale-editor
          end
          source $argv[1]
          for name in EDITOR VISUAL SUDO_EDITOR SYSTEMD_EDITOR
            test "$$name" = "$argv[2]"; or exit 1
            set --query --global $name; or exit 1
          end
        '';
      in
      pkgs.runCommand "rawkos-fish-editor" { nativeBuildInputs = [ pkgs.fish ]; } ''
        export HOME="$TMPDIR/home"
        export XDG_CONFIG_HOME="$HOME/.config"
        mkdir -p "$XDG_CONFIG_HOME"
        fish --no-config ${verify} ${orbEditor} vim
        fish --no-config ${verify} ${studioEditor} 'zed --wait'
        touch "$out"
      '';
    checks.machine-composition =
      pkgs.runCommand "rawkos-machine-composition"
        {
          inherit contract;
          evaluation = builtins.unsafeDiscardStringContext (builtins.toJSON publicEvaluations);
          passAsFile = [ "evaluation" ];
        }
        ''
          cp "$evaluationPath" "$out"
        '';
  };
}
