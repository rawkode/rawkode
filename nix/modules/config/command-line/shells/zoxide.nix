{
  flake.homeModules.zoxide = {
    programs.zoxide = {
      enable = true;
      enableFishIntegration = true;
      enableNushellIntegration = false;
      options = [
        "--cmd cd"
      ];
    };
  };
}
