import { CertManager, Contour, RedPanda, Tyk } from "./platform/components";
import { getController, managedDomains as domains } from "./dns";
import { Platform } from "./platform";
import { ScalewayCluster } from "./cluster/scaleway";

export const managedDomains = domains.reduce(
  (zones, domain) =>
    Object.assign(zones, { [domain.domainName]: domain.zone.id }),
  {}
);

const cluster = new ScalewayCluster("rawkode", {
  name: "rawkode",
})
  .addNodePool("essential", {
    nodeType: "GP1-XS",
    size: 1,
    autoScaling: false,
  })
  .addNodePool("ephemeral", {
    nodeType: "DEV1-M",
    size: 3,
    autoScaling: true,
    maxSize: 5,
  });

const platform = new Platform("rawkode", {
  cluster,
});

platform
  .addComponent("contour", Contour)
  .addComponent("cert-manager", CertManager)
  .addComponent("tyk", Tyk)
  .addComponent("redpanda", RedPanda)
  .addProject("academy", {
    repository: "https://github.com/rawkode-academy/rawkode-academy",
    directory: "platform",
    environment: {
      apiDomain: "api.rawkode.academy",
    },
  });
