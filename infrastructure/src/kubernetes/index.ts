import * as civo from "@pulumi/civo";

interface Args {
  name: string;
  nodePools: NodePool[];
}

interface NodePool {
  instanceType: string;
  numberOfNodes: number;
}
interface Cluster {
  cluster: civo.KubernetesCluster;
}

export const createCluster = (config: Args): Cluster => {
  const network = new civo.Network(config.name, {
    label: config.name,
  });

  const firewall = new civo.Firewall(config.name, {
    networkId: network.id,
  });

  const firewallAllowHttp = new civo.FirewallRule("http", {
    firewallId: firewall.id,
    cidrs: ["0.0.0.0/0"],
    direction: "ingress",
    protocol: "tcp",
    startPort: "80",
  });
  civo.KubernetesNodePool;

  const firewallAllowHttps = new civo.FirewallRule("https", {
    firewallId: firewall.id,
    cidrs: ["0.0.0.0/0"],
    direction: "ingress",
    protocol: "tcp",
    startPort: "443",
  });

  const cluster = new civo.KubernetesCluster(config.name, {
    kubernetesVersion: "1.21.2+k3s1",
    networkId: network.id,
    firewallId: firewall.id,
    numTargetNodes: 1,
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

  return {
    cluster,
  };
};
