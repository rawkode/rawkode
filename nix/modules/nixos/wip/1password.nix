{ lib, pkgs, ... }:
with lib;
with lib.rawkOS;
let
  cfg = config.rawkOS.user;
in
{
  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    package = pkgs._1password-gui-beta;
    polkitPolicyOwners = [ cfg.username ];
  };

  environment.etc = {
    "1password/custom_allowed_browsers" = {
      text = ''
        vivaldi-bin
      '';
      mode = "0755";
    };
  };
}