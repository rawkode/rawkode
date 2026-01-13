{
  flake.homeModules.onepassword = {
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

  flake.darwinModules.onepassword =
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
