{
  flake.homeModules.starship =
    {
      inputs,
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = [
        inputs.jj-starship.packages.${pkgs.stdenv.hostPlatform.system}.default
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

          custom.cuenv_hooks = {
            command = "cuenv env status --hooks --format=starship";
            format = "$output";
            # Only run when cuenv config file exists (avoid running on every prompt)
            when = "test -f env.cue";
            disabled = false;
            description = "cuenv hooks status";
          };
        };
      };
    };
}
