import * as pulumi from "@pulumi/pulumi";
import * as google from "@pulumi/google-native";
import * as k8s from "@pulumi/kubernetes";
import { Controller as DnsController } from "../dns/controller";

interface Args {
  name: string;
  dnsController: DnsController;
}

interface NodePool {
  instanceType: string;
  numberOfNodes: number;
}
interface Cluster {
  provider: k8s.Provider;
}

const essentialNodeConfig: google.types.input.container.v1.NodeConfigArgs = {
  machineType: "e2-small",
  oauthScopes: [
    "https://www.googleapis.com/auth/compute",
    "https://www.googleapis.com/auth/devstorage.read_only",
    "https://www.googleapis.com/auth/logging.write",
    "https://www.googleapis.com/auth/monitoring",
  ],
  preemptible: false,
};

const flexibleNodeConfig: google.types.input.container.v1.NodeConfigArgs = {
  machineType: "e2-standard-2",
  oauthScopes: [
    "https://www.googleapis.com/auth/compute",
    "https://www.googleapis.com/auth/devstorage.read_only",
    "https://www.googleapis.com/auth/logging.write",
    "https://www.googleapis.com/auth/monitoring",
  ],
  preemptible: true,
};

export const createCluster = (config: Args): Cluster => {
  const cluster = new google.container.v1.Cluster(config.name, {
    initialClusterVersion: "1.21.5-gke.1802",
    location: "europe-west1-b",
    locations: ["europe-west1-b"],
    nodePools: [
      {
        name: "pool-essential",
        config: essentialNodeConfig,
        initialNodeCount: 2,
        management: {
          autoRepair: false,
          autoUpgrade: false,
        },
        autoscaling: {
          enabled: false,
        },
        upgradeSettings: {
          maxSurge: 1,
          maxUnavailable: 1,
        },
      },
      {
        name: "pool-flexible",
        config: flexibleNodeConfig,
        initialNodeCount: 2,
        management: {
          autoRepair: true,
          autoUpgrade: true,
        },
        upgradeSettings: {
          maxSurge: 1,
          maxUnavailable: 1,
        },
        autoscaling: {
          enabled: true,
          minNodeCount: 2,
          maxNodeCount: 4,
          autoprovisioned: false,
        },
      },
    ],
  });

  const kubeconfig = pulumi
    .all([cluster.name, cluster.endpoint, cluster.masterAuth])
    .apply(([name, endpoint, masterAuth]) => {
      const context = `${google.config.project}_${google.config.zone}_${name}`;
      return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
  `;
    });

  const provider = new k8s.Provider(config.name, {
    kubeconfig,
  });

  const ingressController = new k8s.helm.v3.Release(
    "ingress-controller",
    {
      chart: "contour",
      repositoryOpts: {
        repo: "https://charts.bitnami.com/bitnami",
      },
      version: "7.3.3",
      namespace: "kube-system",
      values: {},
    },
    {
      provider,
    }
  );

  const svc = k8s.core.v1.Service.get(
    "ingress-controller-service",
    pulumi.interpolate`${ingressController.status.namespace}/${ingressController.status.name}-contour-envoy`,
    {
      provider,
    }
  );

  svc.status.loadBalancer.ingress[0].ip.apply((ip) => {
    config.dnsController.createRecord("@", "A", [ip]);
    config.dnsController.createRecord("*", "A", [ip]);
  });

  return {
    provider,
  };
};
