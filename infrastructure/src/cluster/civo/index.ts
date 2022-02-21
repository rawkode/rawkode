import * as civo from "@pulumi/civo";
import * as kubernetes from "@pulumi/kubernetes";
import { ClusterArgs } from "../";

export const createCluster = (config: ClusterArgs): kubernetes.Provider => {
  const network = new civo.Network(config.name, {
    label: config.name,
    region: "lon1",
  });

  const firewall = new civo.Firewall(config.name, {
    networkId: network.id,
    region: "lon1",
  });

  const firewallAllowControlPlane = new civo.FirewallRule("control-plane", {
    firewallId: firewall.id,
    cidrs: ["0.0.0.0/0"],
    direction: "ingress",
    protocol: "tcp",
    startPort: "6443",
    region: "lon1",
  });

  const firewallAllowHttp = new civo.FirewallRule("http", {
    firewallId: firewall.id,
    cidrs: ["0.0.0.0/0"],
    direction: "ingress",
    protocol: "tcp",
    startPort: "80",
    region: "lon1",
  });

  const firewallAllowHttps = new civo.FirewallRule("https", {
    firewallId: firewall.id,
    cidrs: ["0.0.0.0/0"],
    direction: "ingress",
    protocol: "tcp",
    startPort: "443",
    region: "lon1",
  });

  const cluster = new civo.KubernetesCluster(config.name, {
    kubernetesVersion: "1.20.0-k3s1",
    networkId: network.id,
    firewallId: firewall.id,
    numTargetNodes: 1,
    targetNodesSize: "g4s.kube.xsmall",
    region: "lon1",
    // cni: "cilium",
    applications: "-Traefik,-metrics-server",
  });

  config.nodePools.forEach(
    (nodePool, index) =>
      new civo.KubernetesNodePool(`${config.name}-node-pool-${index}`, {
        clusterId: cluster.id,
        region: "lon1",
        numTargetNodes: nodePool.numberOfNodes,
        targetNodesSize: nodePool.instanceType,
      })
  );

  return new kubernetes.Provider(config.name, {
    kubeconfig: cluster.kubeconfig,
  });
};
