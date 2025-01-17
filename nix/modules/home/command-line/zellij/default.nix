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
      copy_on_select = true;
      ui = {
        pane_frames = {
          hide_session_name = true;
        };
      };
    };
  };
}
