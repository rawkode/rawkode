{ ... }:
{
  programs.vscode.enable = true;

  # We use VSCode settings sync
  catppuccin.vscode.enable = false;

  xdg.configFile."Code/argv.json".text = ''
    {
      "password-store": "gnome-libsecret",
      "enable-crash-reporter": true,
      "crash-reporter-id": "521bfdaa-436c-438a-a54b-7b820b9754b0"
    }
  '';

  home.sessionVariables = {
    NIXOS_OZONE_WL = "1";
  };
}
