import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as k8x from "@pulumi/kubernetesx";
import { managedDomains as domains } from "./dns";
import { createCluster } from "./kubernetes/civo";
import { install as installKnative } from "./kubernetes/knative";

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
  nodePools: [
    {
      instanceType: "g4s.kube.large",
      numberOfNodes: 3,
    },
  ],
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
const operatorDeployment = installPulumiOperator(cluster.provider, "default");

const pulumiConfig = new pulumi.Config();
const pulumiAccessToken = pulumiConfig.requireSecret("pulumiAccessToken");

const accessToken = new k8x.Secret(
  "accesstoken",
  {
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
      stack: "rawkode-academy-platform",
      projectRepo: "https://github.com/rawkode-academy/platform",
      branch: "refs/head/main",
      destroyOnFinalize: true,
    },
  },
  {
    provider: cluster.provider,
    dependsOn: [operatorDeployment],
  }
);
