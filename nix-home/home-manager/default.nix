{ pkgs, stateVersion, username }:

let
  name = "David Flanagan";
  email = "david@rawkode.dev";

  direnv = import ./direnv { inherit pkgs; };
  eza = import ./eza { inherit pkgs; };
  git = import ./git { inherit pkgs name email; };
  github = import ./github { inherit pkgs; };
  nushell = import ./nushell { inherit pkgs; };
  vscode = import ./vscode { inherit pkgs; };
  warp = import ./warp { inherit pkgs; };
	wezterm = import ./wezterm { inherit pkgs; };
in
{
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;

    users.${username} = { pkgs, ... }: {
      home = {
        enableNixpkgsReleaseCheck = false;
        inherit (pkgs) homeDirectory;
        inherit stateVersion username;

        packages = with pkgs; [
          coreutils
          findutils
          tree
          unzip
          wget
          zstd
        ]
        ++ vscode.packages
        ++ warp.packages
        ;
      };

      xdg.configFile = {
				"wezterm" = wezterm.configFiles;
			};

      programs = { home-manager = { enable = true; }; }
        // direnv.program
        // eza.program
        // git.program
        // github.program
        // nushell.program
      ;
    };
  };
}
