import { defineModule } from "@rawkode/dhd"

export default defineModule({
  name: "comma",
  tags: ["nix", "utilities"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Note: comma is a Nix-specific utility that runs programs without installing them
  // It requires Nix to be installed and is typically installed via Nix itself
  // For non-NixOS systems, this module is a placeholder
  // Install with: nix-env -iA nixpkgs.comma
])
