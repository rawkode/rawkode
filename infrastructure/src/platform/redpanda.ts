import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as redpanda from "@pulumiverse/kubernetes-redpanda";

interface InstallArgs {
  namespace: string | pulumi.Output<string>;
  provider: k8s.Provider;
  version: string;
  dependsOn: pulumi.Resource[];
}

type DependOn = pulumi.Resource;

const crdUrl =
  "https://raw.githubusercontent.com/redpanda-data/redpanda/v${VERSION}/src/go/k8s/config/crd/bases/redpanda.vectorized.io_clusters.yaml";

export const install = async (args: InstallArgs): Promise<DependOn> => {
  const crds = new k8s.yaml.ConfigFile(
    `redpanda-crds`,
    { file: crdUrl.replace("${VERSION}", args.version) },
    { provider: args.provider, dependsOn: args.dependsOn }
  );

  const operator = new k8s.helm.v3.Release(
    `redpanda-operator`,
    {
      name: "redpanda-operator",
      chart: "redpanda-operator",
      version: `v${args.version}`,
      repositoryOpts: {
        repo: "https://charts.vectorized.io/",
      },
      namespace: args.namespace,
      values: {
        webhookSecretName: "redpanda-webhook-server-cert",
      },
    },
    {
      provider: args.provider,
      dependsOn: [crds],
    }
  );

  const cluster = new redpanda.redpanda.v1alpha1.Cluster(
    "redpanda",
    {
      metadata: {
        namespace: args.namespace,
        name: "redpanda",
      },
      spec: {
        image: "vectorized/redpanda",
        version: `v${args.version}`,
        replicas: 1,
        resources: {
          requests: {
            cpu: 1,
            memory: "4Gi",
          },
        },
        configuration: {
          developerMode: true,
          adminApi: [
            {
              port: 9644,
            },
          ],
          rpcServer: {
            port: 33145,
          },
          kafkaApi: [
            {
              port: 9092,
              tls: {
                enabled: true,
              },
            },
          ],
          pandaproxyApi: [
            {
              port: 8082,
              tls: {
                enabled: true,
              },
            },
          ],
        },
      },
    },
    {
      provider: args.provider,
      dependsOn: [crds, operator],
    }
  );

  return cluster;
};
