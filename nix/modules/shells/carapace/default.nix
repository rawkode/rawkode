{
  flake.homeModules.carapace = {
    programs.carapace = {
      enable = true;

      enableFishIntegration = true;
      enableNushellIntegration = true;
    };
  };
}
