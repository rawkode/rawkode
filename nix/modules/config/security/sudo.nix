{
  flake.nixosModules.sudo =
    { lib, pkgs, ... }:
    {
      environment.systemPackages = [ pkgs.pam_u2f ];

      security = {
        pam = {
          u2f = {
            enable = true;
            control = "sufficient";
            settings = {
              cue = true;
              cue_prompt = "Tap YubiKey...";
            };
          };
          services.sudo.u2fAuth = true;
        };

        sudo = {
          enable = true;
          execWheelOnly = lib.mkForce true;
          wheelNeedsPassword = true;

          extraConfig = ''
            Defaults lecture = never
            Defaults pwfeedback
            Defaults env_keep += "EDITOR DISPLAY"
            Defaults timestamp_timeout = 15
          '';
        };
      };
    };
}
