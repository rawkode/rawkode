{ pkgs, ... }: {
  programs.atuin = {
    enable = true;
    enableNushellIntegration = true;
  };
}
