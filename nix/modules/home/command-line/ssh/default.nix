{ pkgs, ... }:
{
  home.packages = with pkgs; [ ssh-tpm-agent ];

  programs.ssh = {
    enable = true;

    addKeysToAgent = "true";

    extraConfig = ''
      EnableSSHKeysign yes
      IdentityAgent none
      PKCS11Provider /run/current-system/sw/lib/libtpm2_pkcs11.so
    '';
  };

  home.sessionVariables = {
    SSH_AUTH_SOCK = "/run/user/1000/ssh-tpm-agent.sock";
  };

  programs.fish.interactiveShellInit = ''
    set -x SSH_AUTH_SOCK /run/user/1000/ssh-tpm-agent.sock
  '';

  systemd.user.sockets.ssh-tpm-agent = {
    Install.WantedBy = [ "sockets.target" ];
    Socket = {
      ListenStream = "%t/ssh-tpm-agent.sock";
      SocketMode = "0600";
      Service = "ssh-tpm-agent.service";
    };
  };

  systemd.user.services.ssh-tpm-agent = {
    Install.WantedBy = [ "sockets.target" ];

    Unit = {
      Requires = [ "ssh-tpm-agent.socket" ];
      ConditionEnvironment = "!SSH_AGENT_PID";
    };

    Service = {
      ExecStart = "${pkgs.ssh-tpm-agent}/bin/ssh-tpm-agent -l %t/ssh-tpm-agent.sock";
      PassEnvironment = "SSH_AGENT_PID";
      SuccessExitStatus = 2;
      Type = "simple";
    };
  };
}
