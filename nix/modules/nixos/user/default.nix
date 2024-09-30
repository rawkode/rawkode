{
  config,
  lib,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.rawkOS.user;
in
{
  options.rawkOS.user = with lib.types; {
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
      default = pkgs.nushell;
      defaultText = literalExpression "pkgs.nushell";
      example = literalExpression "pkgs.nushell";
      description = ''
        The path to the user's shell. Can use shell derivations,
        like `pkgs.bashInteractive`. Don’t
        forget to enable your shell in
        `programs` if necessary,
        like `programs.zsh.enable = true;`.
      '';
    };
  };

  config = {
    users.groups.${cfg.username} = {
      gid = 1000;
    };

    users.users.${cfg.username} = {
      isNormalUser = true;
      uid = 1000;
      description = cfg.name;
      shell = cfg.shell;
      extraGroups = [
        "${cfg.username}"
        "adbusers"
        "audio"
        "dialout"
        "docker"
        "input"
        "kvm"
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
}
