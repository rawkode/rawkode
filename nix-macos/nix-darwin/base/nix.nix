{
  buildMachines = [
    {
      hostName = "eu.nixbuild.net";
      system = "x86_64-linux";
      maxJobs = 100;
      supportedFeatures = [ "benchmark" "big-parallel" ];
    }
  ];
  checkConfig = true;
  distributedBuilds = true;
  extraOptions = "";
  registry = { };
  settings = {
    auto-optimise-store = true;
    bash-prompt-prefix = "(nix:$name)\\040";
    build-users-group = "nixbld";
    cores = 10;
    experimental-features = [ "nix-command" "flakes" ];
    extra-experimental-features = [ "repl-flake" ];
    extra-sandbox-paths = [ ];
    extra-nix-path = "nixpkgs=flake:nixpkgs";
    max-jobs = "auto";
    require-sigs = true;
    sandbox = true;
    sandbox-fallback = false;
  };
}