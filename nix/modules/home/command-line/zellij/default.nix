{ ... }:
{
  programs.zellij = {
    enable = true;

    settings = {
      default_mode = "normal";
      default_layout = "compact";
      mouse_mode = true;
      pane_frames = false;
      simplified_ui = false;
      ui = {
        pane_frames = {
          hide_session_name = true;
        };
      };
    };
  };

  xdg.configFile."zellij/init.nu" = {
    source = ./zellij.nu;
  };

  programs.nushell.extraConfig = ''
    source /home/rawkode/.config/zellij/init.nu
  '';
}
