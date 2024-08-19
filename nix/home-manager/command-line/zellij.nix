{
  programs.zellij = {
    enable = true;

    settings = {
      default_mode = "normal";
      default_layout = "compact";
      pane_frames = false;
      simplified_ui = false;
      ui = {
        pane_frames = {
          hide_session_name = true;
        };
      };
    };
  };
}
