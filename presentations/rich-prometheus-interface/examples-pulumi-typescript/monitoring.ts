import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as promSdk from "prometheus-sdk/monitoring";

interface Args {
  provider: k8s.Provider;
  deploymentSpec: k8s.apps.v1.DeploymentArgs;
}

export class MagicDeployment extends pulumi.ComponentResource {
  private provider: k8s.Provider;
  private name: string;
  private deployment: k8s.apps.v1.Deployment;

  constructor(
    name: string,
    args: Args,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("example:monitoring:MagicMonitor", name, args, opts);

    this.name = name;
    this.provider = args.provider;
    this.deployment = new k8s.apps.v1.Deployment(
      `${name}-deployment`,
      args.deploymentSpec,
      {
        provider: this.provider,
      }
    );
  }

  public monitor(portName: string, interval: string) {
    const podMonitor = new promSdk.v1.PodMonitor(
      `${this.name}-pod-monitor`,
      {
        spec: {
          selector: {
            matchLabels: this.deployment.metadata.labels,
          },
          podMetricsEndpoints: [
            {
              port: portName,
              interval: interval,
            },
          ],
        },
      },
      {
        parent: this,
        provider: this.provider,
      }
    );

    const prometheusRule = new promSdk.v1.PrometheusRule(
      `${this.name}-prometheus-rule`,
      {
        metadata: {
          labels: this.deployment.metadata.labels,
        },
        spec: {
          groups: [
            {
              name: "./example.rules",
              rules: [
                {
                  alert: "ExampleAlert",
                  expr: "vector(1)",
                },
              ],
            },
          ],
        },
      },
      {
        parent: this,
        provider: this.provider,
      }
    );
  }

  public deployPrometheus() {
    const prometheusServiceAccount = new k8s.core.v1.ServiceAccount(
      `${this.name}-prometheus`,
      {},
      {
        parent: this,
        provider: this.provider,
      }
    );

    const prometheusClusterRole = new k8s.rbac.v1.ClusterRole(
      `${this.name}-prometheus`,
      {
        rules: [
          {
            apiGroups: [""],
            resources: [
              "nodes",
              "nodes/metrics",
              "services",
              "endpoints",
              "pods",
            ],
            verbs: ["get", "list", "watch"],
          },
          {
            apiGroups: [""],
            resources: ["configmaps"],
            verbs: ["get"],
          },
          {
            apiGroups: ["networking.k8s.io"],
            resources: ["ingresses"],
            verbs: ["get", "list", "watch"],
          },
          {
            nonResourceURLs: ["/metrics"],
            verbs: ["get"],
          },
        ],
      },
      {
        parent: this,
        provider: this.provider,
      }
    );

    const prometheusClusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
      `${this.name}-prometheus`,
      {
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: prometheusClusterRole.metadata.name,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: prometheusServiceAccount.metadata.name,
            namespace: prometheusServiceAccount.metadata.namespace,
          },
        ],
      },
      {
        parent: this,
        provider: this.provider,
      }
    );

    const prometheus = new promSdk.v1.Prometheus(
      `${this.name}-prometheus`,
      {
        spec: {
          replicas: 3,
          serviceAccountName: prometheusServiceAccount.metadata.name,
          serviceMonitorSelector: {
            matchLabels: this.deployment.metadata.labels,
          },
          alerting: {
            alertmanagers: [
              {
                namespace: "default",
                name: "alertmanager-operated",
                port: "web",
              },
            ],
          },
          ruleSelector: {
            matchLabels: this.deployment.metadata.labels,
          },
        },
      },
      {
        parent: this,
        provider: this.provider,
      }
    );

    const alertManager = new promSdk.v1.Alertmanager(
      "alertmanager",
      {
        spec: {
          replicas: 3,
          alertmanagerConfigSelector: {
            matchLabels: this.deployment.metadata.labels,
          },
        },
      },
      {
        parent: this,
        provider: this.provider,
      }
    );
  }
}
