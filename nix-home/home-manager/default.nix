{ pkgs
, stateVersion
, username
}:

{
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;

    users.${username} = { pkgs, ... }: {
      home = {
        enableNixpkgsReleaseCheck = false;
        inherit (pkgs) homeDirectory;
        packages = import ./packages.nix { inherit pkgs; };
        sessionVariables = import ./env.nix { inherit pkgs username; };
        inherit stateVersion username;
      };
      programs = import ./programs.nix { inherit pkgs; };
    };
  };
}
