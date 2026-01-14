{
  flake.homeModules.git-fish = {
    programs.fish = {
      shellAbbrs = {
        gr = {
          expansion = "cd (git root)";
          position = "command";
        };
      };
    };
  };
}
