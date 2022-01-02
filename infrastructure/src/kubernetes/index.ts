import * as civo from "@pulumi/civo";

interface Cluster {
  cluster: civo.KubernetesCluster;
}

export const createCluster = (name): Cluster => {
  const network = new civo.Network(name, {
    label: name,
  });

  const firewall = new civo.Firewall(name, {
    networkId: network.id,
  });

  const firewallAllowHttp = new civo.FirewallRule("http", {
    firewallId: firewall.id,
    cidrs: ["0.0.0.0/0"],
    direction: "ingress",
    protocol: "tcp",
    startPort: "80",
  });

  const firewallAllowHttps = new civo.FirewallRule("https", {
    firewallId: firewall.id,
    cidrs: ["0.0.0.0/0"],
    direction: "ingress",
    protocol: "tcp",
    startPort: "443",
  });

  return {
    cluster: new civo.KubernetesCluster(name, {
      kubernetesVersion: "1.23.0",
      networkId: network.id,
      firewallId: firewall.id,
    }),
  };
};
