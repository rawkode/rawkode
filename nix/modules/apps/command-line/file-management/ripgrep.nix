{
  flake.homeModules.ripgrep = {
    programs.ripgrep = {
      enable = true;

      arguments = [
        "--max-columns=150"
        "--max-columns-preview"
        "--glob=!.git/*"
        "--smart-case"
      ];
    };
  };
}
