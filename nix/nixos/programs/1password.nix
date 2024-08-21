{ pkgs, username, ... }:
{
  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    package = pkgs._1password-gui-beta;
    polkitPolicyOwners = [ username ];
  };

  environment.etc = {
    "1password/custom_allowed_browsers" = {
      text = ''
        vivaldi-bin
        zen
      '';
      mode = "0755";
    };
  };
}
