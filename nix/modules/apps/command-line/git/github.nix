{
  flake.homeModules.github =
    { pkgs, ... }:
    {
      programs.gh = {
        enable = true;

        extensions = with pkgs; [
          gh-copilot
        ];

        settings = {
          git_protocol = "ssh";
          prompt = "enabled";
        };
      };
    };
}
