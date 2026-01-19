{
  flake.homeModules.git-delta = {
    programs.delta = {
      enable = true;
      enableGitIntegration = true;

      options = {
        navigate = true;
        side-by-side = true;
        line-numbers = true;
      };
    };
  };
}
