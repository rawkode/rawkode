{ config, lib, ... }:
with lib;
let
  cfg = config.rawkOS.user;
in
{
  options.rawkOS.user = with lib.types; {
    enable = mkOption {
      type = bool;
      default = false;
      description = "Whether to create a standard user account";
    };

    username = mkOption {
      type = str;
      default = "rawkode";
      description = "The username of the standard account";
    };

    name = mkOption {
      type = str;
      default = "David Flanagan";
      description = "The real name of the standard account";
    };

    shell = mkOption {
      type = types.shellPackage;
      default = pkgs.fish;
      defaultText = literalExpression "pkgs.fish";
      example = literalExpression "pkgs.fish";
      description = ''
        The path to the user's shell. Can use shell derivations,
        like `pkgs.bashInteractive`. Don’t
        forget to enable your shell in
        `programs` if necessary,
        like `programs.zsh.enable = true;`.
      '';
    };

    config = {
      users.groups.${cfg.username} = { };

      config.users.users.${cfg.username} = {
        description = cfg.name;
        isNormalUser = true;
        shell = cfg.shell;
        extraGroups = [
          "${cfg.username}"
          "adbusers"
          "audio"
          "dialout"
          "input"
          "lxd"
          "networkmanager"
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
}
