{ ... }:
{
  programs.fish.functions = {
    nixpkgs-hash-git = {
      description = "Get a nixpkgs hash for a Git revision";
      argumentNames = [
        "repoUrl"
        "revision"
      ];
      body = ''
        nix-shell -p nix-prefetch-git jq --run "nix hash convert sha256:\$(nix-prefetch-git --url $repoUrl --quiet --rev $revision | jq -r '.sha256')"
      '';
    };
  };
}
