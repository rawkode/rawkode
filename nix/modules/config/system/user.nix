let
  mkUserOptions =
    { lib, pkgs }:
    {
      username = lib.mkOption {
        type = lib.types.str;
        description = "The username of the standard account";
      };

      name = lib.mkOption {
        type = lib.types.str;
        description = "The real name of the standard account";
      };

      shell = lib.mkOption {
        type = lib.types.shellPackage;
        default = pkgs.fish;
        defaultText = lib.literalExpression "pkgs.fish";
        example = lib.literalExpression "pkgs.fish";
        description = ''
          The path to the user's shell. Can use shell derivations,
          like `pkgs.bashInteractive`. Don't
          forget to enable your shell in
          `programs` if necessary,
          like `programs.zsh.enable = true;`.
        '';
      };
    };
in
{
  flake.nixosModules.user =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.user;
    in
    {
      options.rawkOS.user = mkUserOptions { inherit lib pkgs; };

      config = {
        users.groups.${cfg.username} = {
          gid = 1000;
        };

        users.users.${cfg.username} = {
          isNormalUser = true;
          uid = 1000;
          description = cfg.name;
          inherit (cfg) shell;
          extraGroups = [
            "${cfg.username}"
            "adbusers"
            "audio"
            "dialout"
            "docker"
            "input"
            "kvm"
            "lxd"
            "osboxes"
            "plugdev"
            "sound"
            "tty"
            "video"
            "wheel"
          ];
        };
      };
    };

  flake.darwinModules.user =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.user;
    in
    {
      options.rawkOS.user = mkUserOptions { inherit lib pkgs; };

      config = {
        users.users.${cfg.username} = {
          name = cfg.username;
          home = "/Users/${cfg.username}";
          inherit (cfg) shell;
        };
      };
    };
}
