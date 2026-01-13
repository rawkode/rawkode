{
  flake.nixosModules.onepassword =
    {
      config,
      ...
    }:
    let
      cfg = config.rawkOS.user;
    in
    {
      config = {
        programs._1password.enable = true;
        programs._1password-gui = {
          enable = true;
          polkitPolicyOwners = [ cfg.username ];
        };

        environment.etc = {
          "1password/custom_allowed_browsers" = {
            text = ''
              firefox-nightly
              firefox-nightly-bin
              vivaldi-bin
            '';
            mode = "0755";
          };
        };
      };
    };
}
