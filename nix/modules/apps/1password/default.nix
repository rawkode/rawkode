{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "onepassword";

  linux.home = _: {
    programs.ssh = {
      enable = true;
      enableDefaultConfig = false;

      matchBlocks = {
        "*" = {
          addKeysToAgent = "true";
          extraOptions = {
            IdentityAgent = "~/.1password/agent.sock";
          };
        };
      };
    };

    dconf.settings = {
      "org/gnome/settings-daemon/plugins/media-keys" = {
        custom-keybindings = [
          "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom-1p/"
        ];
      };

      "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom-1p" = {
        binding = "<Super>period";
        command = "1password --quick-access";
        name = "Search 1Password";
      };
    };
  };

  linux.system =
    { config, ... }:
    let
      cfg = config.rawkOS.user;
    in
    {
      programs._1password.enable = true;
      programs._1password-gui = {
        enable = true;
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
    };

  darwin.home = _: {
    programs.ssh = {
      enable = true;
      enableDefaultConfig = false;

      matchBlocks = {
        "*" = {
          addKeysToAgent = "true";
          extraOptions = {
            IdentityAgent = "\"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";
          };
        };
      };
    };
  };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [
          "1password"
          "1password-cli"
        ];
      };
    };
}
