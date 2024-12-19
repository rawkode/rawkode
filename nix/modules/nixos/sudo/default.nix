{ lib, pkgs, ... }:
{
  security = {
    sudo = {
      enable = true;
      execWheelOnly = lib.mkForce true;
      wheelNeedsPassword = lib.mkDefault false;

      extraConfig = ''
        Defaults lecture = never
        Defaults pwfeedback
        Defaults env_keep += "EDITOR PATH DISPLAY"
        Defaults timestamp_timeout = 300
      '';

      extraRules =
        let
          sudoRules = with pkgs; [
            {
              package = coreutils;
              command = "sync";
            }
            {
              package = hdparm;
              command = "hdparm";
            }
            {
              package = nix;
              command = "nix-collect-garbage";
            }
            {
              package = nix;
              command = "nix-store";
            }
            {
              package = nixos-rebuild;
              command = "nixos-rebuild";
            }
            {
              package = nvme-cli;
              command = "nvme";
            }
            {
              package = systemd;
              command = "poweroff";
            }
            {
              package = systemd;
              command = "reboot";
            }
            {
              package = systemd;
              command = "shutdown";
            }
            {
              package = systemd;
              command = "systemctl";
            }
            {
              package = util-linux;
              command = "dmesg";
            }
          ];

          mkSudoRule = rule: {
            command = lib.getExe' rule.package rule.command;
            options = [ "NOPASSWD" ];
          };

          sudoCommands = map mkSudoRule sudoRules;
        in
        [
          {
            groups = [ "wheel" ];
            commands = sudoCommands;
          }
        ];
    };
  };
}
