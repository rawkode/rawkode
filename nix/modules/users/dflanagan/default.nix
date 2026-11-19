{ inputs, lib, ... }:
let
  mkUser = import ../../../lib/mkUser.nix { inherit inputs lib; };
in
mkUser {
  username = "dflanagan";
  name = "David Flanagan";
  email = "david@rawkode.dev";

  homeExtraConfig = {
    programs.git.includes = [
      {
        condition = "gitdir:~/Code/src/github.com/coreweave/";
        contents.user.email = "dflanagan@coreweave.com";
      }
    ];

    programs.jujutsu.settings."--scope" = [
      {
        "--when".repositories = [ "~/Code/src/github.com/coreweave" ];
        user.email = "dflanagan@coreweave.com";
      }
    ];
  };

  enableHomeConfigurations = true;
}
