{
  flake.homeModules.television = {
    programs.television = {
      enable = true;

      settings = {
        ui = {
          use_nerd_font_icons = true;
        };
        shell_integration = {
          channel_triggers = {
            "dirs" = [
              "cd"
              "ls"
            ];
            "env" = [
              "set"
            ];
            "files" = [
              "bat"
              "cat"
              "cp"
              "less"
              "more"
              "mv"
            ];
          };
        };
      };

      channels = {
        # Already provided by community channels, keeping
        # as an example.
        # git-log = {
        #   name = "Git Log";
        #   source_command = "git log --oneline --date=short --pretty=\"format:%h %s %an %cd\" \"$@\"";
        #   preview_command = "git show -p --stat --pretty=fuller --color=always {0}";
        # };
      };

      enableFishIntegration = true;
    };

    programs.fish.interactiveShellInit = "bind ctrl-g 'tv git-repos'";
  };
}
