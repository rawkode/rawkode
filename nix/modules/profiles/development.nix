{ inputs, ... }:
{
  flake.nixosModules.profiles-development =
    { pkgs, ... }:
    {
      imports = with inputs; [
        self.nixosModules.ai
        self.nixosModules.android
        self.nixosModules.documentation
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
}
