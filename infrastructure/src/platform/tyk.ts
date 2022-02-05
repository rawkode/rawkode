import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

const tykVersions = {
  operator: "0.8.1",
  headless: "0.9.3",
};

const tykCrds = `https://doc.crds.dev/raw/github.com/TykTechnologies/tyk-operator@v${tykVersions.operator}`;

interface InstallArgs {
  namespace: string | pulumi.Output<string>;
  provider: k8s.Provider;
}

export const install = async (args: InstallArgs): Promise<void> => {
  const crds = new k8s.yaml.ConfigFile(
    `tyk-crds`,
    { file: tykCrds },
    { provider: args.provider }
  );

  const tykApiSecret = new random.RandomPassword("tyk-api-secret", {
    length: 32,
  });

  const tykOrgId = new random.RandomUuid("tyk-org-id");

  const redisPassword = new random.RandomPassword("redis-password", {
    length: 32,
  });

  const tykRedis = new k8s.helm.v3.Release(
    `tyk-redis`,
    {
      chart: "redis",
      repositoryOpts: {
        repo: "https://charts.bitnami.com/bitnami",
      },
      version: "16.3.1",
      namespace: args.namespace,
      values: {
        auth: {
          password: redisPassword.result,
        },
      },
    },
    {
      provider: args.provider,
    }
  );

  // const tykMongodb = new k8s.helm.v3.Release(
  //   `tyk-mongodb`,
  //   {
  //     chart: "mongodb",
  //     repositoryOpts: {
  //       repo: "https://charts.bitnami.com/bitnami",
  //     },
  //     version: "11.0.3",
  //     namespace: args.namespace,
  //     values: {
  //       replicaSet: {
  //         enabled: true,
  //       },
  //     },
  //     skipAwait: true,
  //   },
  //   {
  //     provider: args.provider,
  //   }
  // );

  const tykRedisService = k8s.core.v1.Service.get(
    "tyk-redis-service",
    pulumi.interpolate`${tykRedis.status.namespace}/${tykRedis.status.name}-master`,
    {
      provider: args.provider,
      dependsOn: [tykRedis],
    }
  );

  const tykGateway = new k8s.helm.v3.Release(
    `tyk-gateway`,
    {
      chart: "tyk-headless",
      repositoryOpts: {
        repo: "https://helm.tyk.io/public/helm/charts/",
      },
      version: tykVersions.headless,
      namespace: args.namespace,
      values: {
        gateway: {
          tls: "true",
        },
        secrets: {
          APISecret: pulumi.interpolate`${tykApiSecret.result}`,
          OrgID: pulumi.interpolate`${tykOrgId.result}`,
        },
        redis: {
          addrs: [
            pulumi.interpolate`${tykRedisService.metadata.name}.${tykRedisService.metadata.namespace}.svc.cluster.local:6379`,
          ],
          pass: pulumi.interpolate`${redisPassword.result}`,
        },
      },
    },
    {
      provider: args.provider,
      dependsOn: [tykRedis, tykRedisService],
    }
  );

  const tykGatewayService = k8s.core.v1.Service.get(
    "tyk-gateway-service",
    pulumi.interpolate`${tykGateway.status.namespace}/gateway-svc-${tykGateway.status.name}-tyk-headless`,
    {
      provider: args.provider,
      dependsOn: [tykRedis, tykGateway],
    }
  );

  const tykOperatorConfig = new k8s.core.v1.Secret(
    "tyk-operator-config",
    {
      metadata: {
        name: "tyk-operator-conf",
        namespace: args.namespace,
      },
      stringData: {
        TYK_AUTH: pulumi.interpolate`${tykApiSecret.result}`,
        TYK_ORG: pulumi.interpolate`${tykOrgId.result}`,
        TYK_URL: pulumi.interpolate`https://${tykGatewayService.metadata.name}.${tykGatewayService.metadata.namespace}.svc.cluster.local`,
        TYK_TLS_INSECURE_SKIP_VERIFY: "true",
        TYK_MODE: "ce",
      },
    },
    {
      provider: args.provider,
    }
  );

  const tykOperator = new k8s.helm.v3.Release(
    `tyk-operator`,
    {
      chart: "tyk-operator",
      repositoryOpts: {
        repo: "https://helm.tyk.io/public/helm/charts/",
      },
      version: tykVersions.operator,
      namespace: args.namespace,
      values: {
        envFrom: [
          {
            secretRef: {
              name: pulumi.interpolate`${tykOperatorConfig.metadata.name}`,
            },
          },
        ],
      },
    },
    {
      provider: args.provider,
      dependsOn: [crds, tykOperatorConfig],
    }
  );

  return;
};
