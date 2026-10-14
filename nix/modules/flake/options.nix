{ lib, ... }:
let
  capabilitySelectionType = lib.types.submodule {
    options = {
      editor = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Editor override for this user on this machine, including standalone Home Manager.";
      };

      modules = lib.mkOption {
        type = lib.types.listOf lib.types.deferredModule;
        default = [ ];
        description = "Host-local Home Manager modules, shared by integrated and standalone configurations.";
      };

      capabilities = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Additional capabilities enabled for this user.";
      };

      disabledCapabilities = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Capabilities disabled for this user.";
      };
    };
  };

  machineManifestType = lib.types.submodule {
    options = {
      platform = lib.mkOption {
        type = lib.types.enum [
          "darwin"
          "nixos"
        ];
        description = "Operating-system module family used by this machine.";
      };

      system = lib.mkOption {
        type = lib.types.enum [
          "aarch64-darwin"
          "aarch64-linux"
          "x86_64-darwin"
          "x86_64-linux"
        ];
        description = "Nix system used to evaluate this machine.";
      };

      primaryUser = lib.mkOption {
        type = lib.types.str;
        description = "Primary user declared by this machine.";
      };

      users = lib.mkOption {
        type = lib.types.attrsOf capabilitySelectionType;
        description = "Users authorized for this machine.";
      };

      capabilities = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Capabilities enabled for this machine and its users.";
      };

      disabledCapabilities = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Capabilities disabled for this machine and its users.";
      };

      traits = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Hardware and platform traits applied to this machine.";
      };

      modules = lib.mkOption {
        type = lib.types.listOf lib.types.deferredModule;
        default = [ ];
        description = "Machine-local NixOS or nix-darwin modules.";
      };
    };
  };
in
{
  options.flake.darwinModules = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "Darwin modules exported by this flake.";
  };

  options.flake.darwinConfigurations = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "Darwin configurations exported by this flake.";
  };

  options.flake.appBundles = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "App bundles exported by this flake (home + darwin + nixos modules).";
  };

  options.flake.capabilityBundles = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "Capability bundles exported by this flake (home + darwin + nixos modules).";
  };

  options.flake.machineManifests = lib.mkOption {
    type = lib.types.lazyAttrsOf machineManifestType;
    default = { };
    description = "Per-machine capability manifests exported by this flake.";
  };

  options.flake.machineTraits = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "Reusable machine hardware and platform trait modules.";
  };

  options.flake.devenvMachines = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "devenv Machines role modules generated from the machine manifests.";
  };

  # NOTE: Other flake.* options (homeModules, nixosModules, nixosConfigurations,
  # overlays, packages, etc.) are provided elsewhere (via import-tree/flake-parts)
  # and should not be redeclared here to avoid merge conflicts.
}
