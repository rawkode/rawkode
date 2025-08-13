{ lib, ... }:
{
  programs.starship = {
    enable = true;
    enableFishIntegration = true;
    enableNushellIntegration = true;

    settings = {
      add_newline = true;
      aws.disabled = true;
      gcloud.disabled = true;
      format = lib.concatStrings [
        "$username"
        "$hostname"
        "$directory"
        "$git_branch"
        "$git_state"
        "$git_status"
        "\${custom.cuenv_hooks}"
        "$cmd_duration"
        "$line_break"
        "$python"
        "$character"
      ];

      directory = lib.mkForce { style = "blue"; };

      character = lib.mkForce {
        success_symbol = "[❯](purple)";
        error_symbol = "[❯](red)";
        vimcmd_symbol = "[❮](green)";
      };

      git_branch = lib.mkForce {
        format = "[$branch]($style)";
        style = "bright-black";
      };

      git_status = lib.mkForce {
        format = "[[(*$conflicted$untracked$modified$staged$renamed$deleted)](218) ($ahead_behind$stashed)]($style)";
        style = "cyan";
        # Note the chars in the quotes are zero width spaces for marking word breaks.
        conflicted = "​";
        untracked = "​";
        modified = "​";
        staged = "​";
        renamed = "​";
        deleted = "​";
        stashed = "≡";
      };

      git_state = lib.mkForce {
        format = ''\([$state( $progress_current/$progress_total)]($style)\) '';
        style = "bright-black";
      };

      cmd_duration = lib.mkForce {
        format = "[$duration]($style) ";
        style = "yellow";
      };

      custom.cuenv_hooks = {
        command = "cuenv env status --hooks --format=starship";
        format = "$output";
        when = "true";
        disabled = false;
        description = "cuenv hooks status";
      };
    };
  };
}
