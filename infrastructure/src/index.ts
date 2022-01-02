import { managedDomains as domains } from "./dns";
import { createCluster } from "./kubernetes";

export const managedDomains = domains.reduce(
  (zones, domain) =>
    Object.assign(zones, { [domain.domainName]: domain.zone.id }),
  {}
);

const cluster = createCluster({
  name: "production",
  nodePools: [
    {
      instanceType: "medium",
      numberOfNodes: 2,
    },
  ],
});

export const kubeconfig = cluster.cluster.kubeconfig;
