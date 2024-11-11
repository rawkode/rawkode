import { $ } from "zx";

// This stops some rpm packages from failing to install
// such as 1Password, Chrome, and Vivaldi.
await $`mkdir --parents /var/opt`;
await $`mkdir --parents /var/lib/alternatives`;
await $`ln --symbolic /usr/bin/ld.bfd /etc/alternatives/ld`;

import setupMonaspace from "./fonts/monaspace/mod.ts";
await setupMonaspace();

import setupFirefox from "./desktop/firefox/mod.ts";
await setupFirefox();

import setupChrome from "./desktop/google-chrome/mod.ts";
await setupChrome();

import setupOnePassword from "./desktop/onepassword/mod.ts";
await setupOnePassword();

import setupVisualStudioCode from "./desktop/visual-studio-code/mod.ts";
await setupVisualStudioCode();

import setupNushell from "./command-line/nushell/mod.ts";
await setupNushell();

import setupFish from "./command-line/fish/mod.ts";
await setupFish();

import setupDirenv from "./command-line/direnv/mod.ts";
await setupDirenv();

import setupDocker from "./command-line/docker/mod.ts";
await setupDocker();

import setupGitHub from "./command-line/github/mod.ts";
await setupGitHub();

import setupDistroBox from "./dev/distrobox/mod.ts";
await setupDistroBox();

import setupRunme from "./command-line/runme/mod.ts";
await setupRunme();

import setupTailscale from "./command-line/tailscale/mod.ts";
await setupTailscale();

import fixAmdIssue from "./fixes/amd/mod.ts";
await fixAmdIssue();

import rawkOS from "./command-line/rawkOS/mod.ts";
await rawkOS();
