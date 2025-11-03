import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "gitsign",
  tags: ["git", "security"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install gitsign - keyless Git signing with Sigstore
  install("gitsign"),

  // Note: To enable gitsign for Git commits, add to your .gitconfig:
  // [gpg]
  //   format = x509
  // [gpg "x509"]
  //   program = gitsign
  // [commit]
  //   gpgsign = true

  // Note: systemd/launchd services for credential cache are Linux/systemd specific
  // and may need separate setup on macOS
])
