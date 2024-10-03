{
  programs.atuin = {
    enable = true;

    enableFishIntegration = true;
    enableNushellIntegration = true;

    settings = {
      style = "compact";
      show_preview = true;
      enter_accept = true;
      search_mode = "skim";
      filter_mode = "session";
      filter_mode_shell_up_key_binding = "session";
    };
  };
}
