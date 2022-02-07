import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as scaleway from "@jaxxstorm/pulumi-scaleway";

import { managedDomains as domains } from "./dns";
import { Cluster } from "./cluster";

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

const scalewayCluster = new scaleway.KubernetesCluster("rawkode-production", {
  name: "rawkode-production",
  cni: "cilium",
  version: "1.23.2",
  type: "kapsule",
  deleteAdditionalResources: true,
});

const scalewayNodePoolEssential = new scaleway.KubernetesNodePool("essential", {
  clusterId: scalewayCluster.id,
  nodeType: "GP1-XS",
  containerRuntime: "containerd",
  minSize: 1,
  maxSize: 3,
  size: 1,
  autoscaling: false,
  autohealing: true,
});

const scalewayNodePoolEphemeral = new scaleway.KubernetesNodePool("ephemeral", {
  clusterId: scalewayCluster.id,
  nodeType: "DEV1-L",
  containerRuntime: "containerd",
  minSize: 1,
  maxSize: 5,
  size: 1,
  autoscaling: true,
  autohealing: true,
});

const config = new pulumi.Config();

const cluster: Cluster = {
  provider: new k8s.Provider("platform", {
    kubeconfig: scalewayCluster.kubeconfigs[0].configFile,
  }),
};

import { create as createPlatform } from "./platform";
createPlatform({
  cluster,
  domainController: clusterDomain,
});
