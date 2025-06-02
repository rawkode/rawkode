import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("pcmanfm")
  .description("PCManFM file manager")
  .tags("desktop", "file-manager")
  .packageInstall({
    manager: "pacman",
    packages: ["pcmanfm-gtk3"],
  })
  .build();
