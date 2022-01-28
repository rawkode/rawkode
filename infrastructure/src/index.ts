import * as k8s from "@pulumi/kubernetes";
import { managedDomains as domains } from "./dns";
import { createCluster } from "./kubernetes";

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

const cluster = createCluster({
  name: "rawkode-production",
  dnsController: clusterDomain,
});

// Deploy Knative
import { install as knativeInstall } from "./kubernetes/knative";
knativeInstall("v1.1.0", cluster.provider);
