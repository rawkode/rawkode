import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as k8x from "@pulumi/kubernetesx";
import { managedDomains as domains } from "./dns";
import { Cluster } from "./kubernetes/";

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

// Will bring this back in when Civo launches a new feature ...
// const cluster = createCluster({
//   name: "rawkode-production",
//   dnsController: clusterDomain,
//   nodePools: [
//     {
//       instanceType: "g4s.kube.large",
//       numberOfNodes: 3,
//     },
//   ],
// });

const config = new pulumi.Config();

const cluster: Cluster = {
  provider: new k8s.Provider("civo", {
    kubeconfig: config.requireSecret("kubeconfig"),
  }),
};

const ingressController = new k8s.helm.v3.Release(
  "ingress-controller",
  {
    chart: "contour",
    repositoryOpts: {
      repo: "https://charts.bitnami.com/bitnami",
    },
    version: "7.3.3",
    namespace: "kube-system",
    values: {
      defaultBackend: {
        enabled: true,
        containerPorts: {
          http: 8080,
        },
      },
      envoy: {
        useHostPort: false,
      },
    },
  },
  {
    provider: cluster.provider,
  }
);

const svc = k8s.core.v1.Service.get(
  "ingress-controller-service",
  pulumi.interpolate`${ingressController.status.namespace}/${ingressController.status.name}-contour-envoy`,
  {
    provider: cluster.provider,
  }
);

svc.status.loadBalancer.ingress[0].ip.apply((ip) => {
  clusterDomain.createRecord("@", "A", [ip]);
  clusterDomain.createRecord("*", "A", [ip]);
});

import { install as installPulumiOperator } from "./pulumi-operator";
const academyNamespace = new k8s.core.v1.Namespace("academy", {
  metadata: {
    name: "academy",
  },
});

const operatorDeployment = installPulumiOperator(
  cluster.provider,
  academyNamespace.metadata.name
);

const pulumiConfig = new pulumi.Config();
const pulumiAccessToken = pulumiConfig.requireSecret("pulumiAccessToken");

const accessToken = new k8x.Secret(
  "accesstoken",
  {
    metadata: {
      namespace: academyNamespace.metadata.name,
    },
    stringData: { accessToken: pulumiAccessToken },
  },
  {
    provider: cluster.provider,
  }
);

const rawkodeAcademyPlatform = new k8s.apiextensions.CustomResource(
  "rawkode-academy-platform",
  {
    apiVersion: "pulumi.com/v1",
    kind: "Stack",
    metadata: {
      namespace: academyNamespace.metadata.name,
    },
    spec: {
      envRefs: {
        PULUMI_ACCESS_TOKEN: {
          type: "Secret",
          secret: {
            name: accessToken.metadata.name,
            key: "accessToken",
          },
        },
      },
      stack: clusterDomain.domainName,
      projectRepo: "https://github.com/rawkode-academy/platform",
      branch: "refs/heads/main",
      resyncFrequencySeconds: 60,
      destroyOnFinalize: true,
    },
  },
  {
    provider: cluster.provider,
    dependsOn: [operatorDeployment],
  }
);
