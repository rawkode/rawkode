{ inputs, ... }:
{
  flake.nixosModules.profiles-development =
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
}
