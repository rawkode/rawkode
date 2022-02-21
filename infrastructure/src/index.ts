import { managedDomains as domains } from "./dns";

export const managedDomains = domains.reduce(
  (zones, domain) =>
    Object.assign(zones, { [domain.domainName]: domain.zone.id }),
  {}
);

const clusterDomain = domains.find(
  (domain) => domain.domainName === "rawkode.sh"
);

if (!clusterDomain) {
  throw new Error("clusterDomain, rawkode.sh, not found");
}

import { createCluster } from "./cluster/scaleway";
const cluster = createCluster({
  name: "rawkode-production",
});

import { create as createPlatform } from "./platform";
createPlatform({
  cluster,
  domainController: clusterDomain,
});
