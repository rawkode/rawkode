let
  daemonSettingNames = [
    "trusted-users"
    "extra-substituters"
    "extra-trusted-public-keys"
    "extra-trusted-substituters"
  ];

  isNonEmpty =
    value:
    if builtins.isList value then
      value != [ ]
    else if builtins.isString value then
      value != ""
    else
      value != null;

  renderSettingValue =
    lib: value:
    if builtins.isList value then
      lib.concatStringsSep " " (map (renderSettingValue lib) value)
    else if builtins.isBool value then
      lib.boolToString value
    else
      toString value;

  renderDaemonSettings =
    lib: settings:
    let
      daemonSettings = lib.filterAttrs (
        name: value: builtins.elem name daemonSettingNames && isNonEmpty value
      ) settings;

      renderSetting = name: value: "${name} = ${renderSettingValue lib value}";
    in
    lib.concatStringsSep "\n" (lib.mapAttrsToList renderSetting daemonSettings);
in
{
  flake.nixosModules.nix =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.user;
      bootstrapConfigText = renderDaemonSettings lib config.nix.settings;
    in
    {
      environment.systemPackages = with pkgs; [
        nix-forecast
        nixd
        nixfmt
      ];

      programs.nh = {
        enable = true;
        clean.enable = true;
        clean.extraArgs = "--keep-since 7d --keep 3";
      };

      nix = {
        optimise.automatic = true;
        gc.automatic = false; # Disabled in favor of programs.nh.clean

        settings = {
          trusted-users = [
            "root"
            cfg.username
          ];
          auto-optimise-store = true;
          experimental-features = [
            "nix-command"
            "flakes"
          ];
          warn-dirty = false;
          keep-derivations = true;
          keep-outputs = true;

          # App/module-specific caches are configured in their own modules.
          extra-substituters = [ "https://cache.nixos.org/" ];
          extra-trusted-public-keys = [
            "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
          ];
        };
      };

      environment.etc."rawkos-nix-bootstrap.conf".text = ''
        # Managed by rawkOS bootstrap.

        ${bootstrapConfigText}
      '';
    };

  flake.darwinModules.nix =
    {
      config,
      lib,
      ...
    }:
    let
      cfg = config.rawkOS.user;
      bootstrapConfigText = renderDaemonSettings lib config.nix.settings;
    in
    {
      nix.settings = {
        trusted-users = [
          "root"
          cfg.username
        ];

        # App/module-specific caches are configured in their own modules.
        extra-substituters = [ "https://cache.nixos.org/" ];
        extra-trusted-public-keys = [
          "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        ];
      };

      # Determinate Nix owns /etc/nix/nix.conf and includes nix.custom.conf.
      # Materialize the merged nix.settings there so darwin switches program the
      # daemon-side trust and cache configuration instead of only user nix.conf.
      environment.etc."nix/nix.custom.conf".text = ''
        # Managed by nix-darwin for Determinate Nix.
        # /etc/nix/nix.conf is owned by Determinate and includes this file.

        ${bootstrapConfigText}
      '';

      environment.etc."rawkos-nix-bootstrap.conf".text = ''
        # Managed by rawkOS bootstrap.

        ${bootstrapConfigText}
      '';
    };

  flake.homeModules.nix-home =
    { lib, pkgs, ... }:
    {
      nix = {
        package = lib.mkDefault pkgs.nix;
        settings = {
          experimental-features = [
            "nix-command"
            "flakes"
          ];
          # Keep cache.nixos.org in user-level nix.conf so app modules can add caches
          # without overriding the primary binary cache.
          substituters = [ "https://cache.nixos.org/" ];
          trusted-public-keys = [
            "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
          ];
        };
      };

      home.packages = with pkgs; [
        nixd
      ];

      programs.fish.functions = {
        nixpkgs-hash-git = {
          description = "Get a nixpkgs hash for a Git revision";
          argumentNames = [
            "repoUrl"
            "revision"
          ];
          body = ''
            nix-shell -p nix-prefetch-git jq --run "nix hash convert sha256:\$(nix-prefetch-git --url $repoUrl --quiet --rev $revision | jq -r '.sha256')"
          '';
        };
      };
    };
}
