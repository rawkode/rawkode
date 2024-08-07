{
  programs.fish = {
    enable = true;

    shellAliases = {
			"docker" = "podman";
      "ghb" = "cd ~/Code/src/github.com";
    };

    interactiveShellInit = ''
      set fish_greeting ""
      bind \r magic-enter
    '';

    functions = {
      magic-enter = {
        description = "Magic Enter";
        body = ''
          set -l cmd (commandline)
          if test -z "$cmd"
            commandline -r (magic-enter-command)
            commandline -f suppress-autosuggestion
          end
          commandline -f execute
        '';
      };

      magic-enter-command = {
        description = "Magic Enter AutoCommands";
        body = ''
          set -l cmd ll
          set -l is_git_repository (fish -c "git rev-parse --is-inside-work-tree >&2" 2>| grep true) # Special variable indicating git.
          set -l repo_has_changes (git status -s --ignore-submodules=dirty)

          if test -n "$is_git_repository"
            if test -n "$repo_has_changes"
              set cmd git status
            end
          end

          echo $cmd
        '';
      };
    };
  };
}
