import * as google from "@pulumi/google-native";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { Args, Cluster } from "..";

const essentialNodeConfig: google.types.input.container.v1.NodeConfigArgs = {
  machineType: "e2-small",
  oauthScopes: [
    "https://www.googleapis.com/auth/compute",
    "https://www.googleapis.com/auth/devstorage.read_only",
    "https://www.googleapis.com/auth/logging.write",
    "https://www.googleapis.com/auth/monitoring",
  ],
  preemptible: false,
  tags: ["http-server", "https-server"],
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
  tags: ["http-server", "https-server"],
};

export const createCluster = (config: Args): Cluster => {
  const cluster = new google.container.v1.Cluster(config.name, {
    initialClusterVersion: "1.21.5-gke.1802",
    location: "europe-west1-b",
    locations: ["europe-west1-b"],
    loggingService: "none",
    monitoringService: "none",
    workloadIdentityConfig: {
      workloadPool: `${google.config.project}.svc.id.goog`,
    },
    ipAllocationPolicy: {
      useIpAliases: true,
    },
    addonsConfig: {
      httpLoadBalancing: {
        disabled: false,
      },
      kubernetesDashboard: {
        disabled: true,
      },
      networkPolicyConfig: {
        disabled: false,
      },
    },
    networkConfig: {
      datapathProvider: "ADVANCED_DATAPATH",
    },
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

  return {
    provider,
  };
};
