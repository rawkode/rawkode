{
  flake.homeModules.git-gitsign =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ gitsign ];

      # programs.fish.interactiveShellInit = lib.rawkOS.fileAsSeparatedString ./gitsign-credential-cache.fish;

      # systemd.user.services.gitsign-credential-cache = {
      #   Install.WantedBy = [ "default.target" ];

      #   Service = {
      #     ExecStart = "${pkgs.gitsign}/bin/gitsign-credential-cache";
      #     Type = "simple";
      #   };
      # };

      # systemd.user.sockets.gitsign-credential-cache = {
      #   Install.WantedBy = [ "default.target" ];
      #   Socket = {
      #     ListenStream = "%C/sigstore/gitsign/cache.sock";
      #     DirectoryMode = "0700";
      #   };
      # };

      # programs.git = {
      #   extraConfig = {
      #     gpg = {
      #       format = "x509";
      #       x509.program = "${pkgs.gitsign}/bin/gitsign";
      #     };

      #     commit.gpgsign = true;
      #   };
      # };
    };
}
