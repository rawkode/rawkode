_: {
  flake.homeModules.jj =
    { identity, preferences, ... }:
    {
      programs.jujutsu = {
        enable = true;
        settings = {
          user = {
            inherit (identity) name;
            inherit (identity) email;
          };
          ui = {
            default-command = [
              "log"
              "--reversed"
              "--no-pager"
            ];
            inherit (preferences) editor;
          };
        };
      };
    };
}
