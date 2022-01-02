import { managedDomains as domains } from "./dns";
import { createCluster } from "./kubernetes";

export const managedDomains = domains.reduce(
  (zones, domain) =>
    Object.assign(zones, { [domain.domainName]: domain.zone.id }),
  {}
);

const cluster = createCluster("production");

export const kubeconfig = cluster.cluster.kubeconfig;
