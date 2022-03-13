import * as kubernetes from "@pulumi/kubernetes";
import * as redpanda from "@pulumiverse/kubernetes-redpanda";

import { Component, ComponentArgs } from "./abstract";
import { CertManager } from "./certManager";

export class RedPanda extends Component {
  protected readonly version = "21.11.10";
  protected readonly crdsUrl =
    "https://raw.githubusercontent.com/redpanda-data/redpanda/v${VERSION}/src/go/k8s/config/crd/bases/redpanda.vectorized.io_clusters.yaml";

  static getComponentName(): string {
    return "red-panda";
  }

  static getDependencies(): string[] {
    return [CertManager.getComponentName()];
  }

  constructor(name: string, args: ComponentArgs) {
    super(name, args);

    const crds = new kubernetes.yaml.ConfigFile(
      `${this.name}-crds`,
      { file: this.crdsUrl.replace("${VERSION}", this.version) },
      { provider: this.provider, parent: this }
    );

    const operator = new kubernetes.helm.v3.Release(
      `${this.name}-operator`,
      {
        chart: "redpanda-operator",
        version: `v${this.version}`,
        skipAwait: true,
        repositoryOpts: {
          repo: "https://charts.vectorized.io/",
        },
        namespace: args.namespace,
        values: {
          webhookSecretName: "redpanda-webhook-server-cert",
        },
      },
      {
        parent: this,
        provider: args.provider,
        dependsOn: crds,
      }
    );
    this.resources.push(operator);

    const cluster = new redpanda.redpanda.v1alpha1.Cluster(
      `${this.name}-cluster`,
      {
        metadata: {
          namespace: args.namespace,
          name,
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          image: "vectorized/redpanda",
          version: `v${this.version}`,
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
        parent: this,
        provider: args.provider,
        dependsOn: operator,
      }
    );
  }
}
