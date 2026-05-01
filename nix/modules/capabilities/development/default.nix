{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "development";

  home = with inputs.self.appBundles; [
    ai.home
    pi.home
    visual-studio-code.home
    zed.home

    bun.home
    comma.home
    cuenv.home
    cue.home
    deno.home
    devenv.home
    direnv.home
    go.home
    just.home
    nh.home
    nix-dev.home
    python.home
    rust.home
  ];

  nixos =
    { pkgs, ... }:
    {
      imports = [
        inputs.self.nixosModules.ai
        inputs.self.nixosModules.android
        inputs.self.nixosModules.documentation
      ];

      environment.systemPackages = with pkgs; [
        cmake
        docker-compose
        gcc
        gdb
        gh
        git
        gnumake
        ltrace
        neovim
        nmap
        pkg-config
        podman-compose
        strace
        tcpdump
        vim
        wireshark
      ];

      boot.kernel.sysctl = {
        "fs.inotify.max_user_watches" = 524288;
        "fs.inotify.max_user_instances" = 1024;
      };
    };

  darwin = with inputs.self.appBundles; [
    ai.darwin
    pi.darwin
    visual-studio-code.darwin
    zed.darwin

    bun.darwin
    comma.darwin
    cuenv.darwin
    cue.darwin
    deno.darwin
    devenv.darwin
    direnv.darwin
    go.darwin
    just.darwin
    nh.darwin
    nix-dev.darwin
    python.darwin
    rust.darwin
  ];
}
