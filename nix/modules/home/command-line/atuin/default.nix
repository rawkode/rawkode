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
      filter_mode = "directory";
      filter_mode_shell_up_key_binding = "session";
      inline_height = 0; # Do not clear screen when tab / enter
    };
  };
}
