{ pkgs }:

{
  program.nushell = {
    enable = true;
    extraEnv = ''
      if ("~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" | path exists) {
        $env.SSH_AUTH_SOCK = ("~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" | path expand)
      }
    '';
  };
}
