{
  programs.starship = {
    enable = true;
    enableFishIntegration = true;

    settings = {
      add_newline = true;

      format = "$all";
      /*
        format = lib.concatStrings [   # Default is fine anyways https://starship.rs/config/#prompt
          "$shlvl$directory"
          "$git_branch$git_commit$git_state$git_metrics$git_status"
          "$line_break"
          "$jobs$battery$time$status$container$shell$character"
        ];
      */

      scan_timeout = 30;
    };
  };
}
