{ config, pkgs, ... }:
let cfg = config.rawkOS.user;
in {
  config = {
    programs._1password.enable = true;
    programs._1password-gui = {
      enable = true;
      package = pkgs._1password-gui;
      polkitPolicyOwners = [ cfg.username ];
    };
  };
}
