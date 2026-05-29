{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "starship";

  common.home =
    {
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = [
        pkgs.jj-starship
      ];

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
            "\${custom.jj}"
            "$git_state"
            "$cmd_duration"
            "$line_break"
            "$python"
            "$shlvl"
            "$character"
          ];

          directory = lib.mkForce { style = "blue"; };

          character = lib.mkForce {
            success_symbol = "[❯](purple)";
            error_symbol = "[❯](red)";
            vimcmd_symbol = "[❮](green)";
          };

          # Repeat the prompt character once per nested shell level (❯ → ❯❯ → ❯❯❯).
          # repeat_offset = 1 leaves the final, status-colored ❯ to the character module,
          # so total ❯ count == $SHLVL.
          shlvl = {
            disabled = false;
            symbol = "❯";
            repeat = true;
            repeat_offset = 1;
            threshold = 0;
            format = "[$symbol]($style)";
            style = "purple";
          };

          # Disabled in favor of jj-starship (handles both Git and JJ repos)
          git_branch.disabled = true;
          git_status.disabled = true;

          git_state = lib.mkForce {
            format = ''\([$state( $progress_current/$progress_total)]($style)\) '';
            style = "bright-black";
          };

          cmd_duration = lib.mkForce {
            format = "[$duration]($style) ";
            style = "yellow";
          };

          custom.jj = {
            when = "jj-starship detect";
            shell = [ "jj-starship" ];
            format = "$output ";
            description = "Unified Git/Jujutsu prompt via jj-starship";
          };
        };
      };
    };
}
