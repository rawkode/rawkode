import { defineModule, install, runCommand } from "@rawkode/dhd"

export default defineModule({
  name: "bloom",
  tags: ["ai", "gui"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  install("bloom", { brew: "homebrew/cask/bloom" }),
  runCommand("defaults write -g NSFileViewer -string com.asiafu.Bloom"),
  runCommand(
    `defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | grep -q "com.asiafu.Bloom" || defaults write com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers -array-add '{LSHandlerContentType="public.folder";LSHandlerRoleAll="com.asiafu.Bloom";}'`
  ),
])
