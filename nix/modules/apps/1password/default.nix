_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "onepassword";

  linux.home = _: {
    programs.ssh = {
      enable = true;
      enableDefaultConfig = false;

      settings."*" = {
        AddKeysToAgent = "yes";
        IdentityAgent = "~/.1password/agent.sock";
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

      # 1Password only trusts browsers it recognises by process name; Firefox
      # Nightly runs as `firefox-nightly`. The mode makes this a root-owned file
      # rather than a store symlink, which 1Password refuses to read.
      environment.etc."1password/custom_allowed_browsers" = {
        text = ''
          firefox-nightly
        '';
        mode = "0755";
      };
    };

  darwin.home = _: {
    programs.ssh = {
      enable = true;
      enableDefaultConfig = false;

      settings."*" = {
        AddKeysToAgent = "yes";
        IdentityAgent = "\"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";
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
