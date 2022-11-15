import * as k8s from "@pulumi/kubernetes";
import * as promSdk from "prometheus-sdk/monitoring";
import { MagicDeployment } from "./monitoring";

const provider = new k8s.Provider("kubernetes", {
  enableServerSideApply: true,
});

const myDeployment = new MagicDeployment("my-deployment", {
  deploymentSpec: {},
  provider,
});

const deployTheThing = () => {
  const appLabels = { app: "osmc" };

  const app = new k8s.apps.v1.Deployment(
    "our-app",
    {
      metadata: {
        labels: appLabels,
      },
      spec: {
        selector: {
          matchLabels: appLabels,
        },
        template: {
          metadata: {
            labels: appLabels,
          },
          spec: {
            containers: [
              {
                name: "app",
                image: "fabxc/instrumented_app",
                imagePullPolicy: "IfNotPresent",
                ports: [
                  {
                    name: "web",
                    containerPort: 8080,
                  },
                ],
              },
            ],
          },
        },
      },
    },
    {
      provider,
    }
  );

  const service = new k8s.core.v1.Service(
    "our-app",
    {
      spec: {
        selector: appLabels,
        ports: [
          {
            name: "web",
            port: 8080,
          },
        ],
      },
    },
    {
      provider,
    }
  );

  const prometheusServiceAccount = new k8s.core.v1.ServiceAccount(
    "prometheus",
    {},
    {
      provider,
    }
  );

  const prometheusClusterRole = new k8s.rbac.v1.ClusterRole(
    "prometheus",
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
      provider,
    }
  );

  const prometheusClusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
    "prometheus",
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
      provider,
    }
  );

  const prometheus = new promSdk.v1.Prometheus(
    "prometheus",
    {
      spec: {
        replicas: 3,
        serviceAccountName: prometheusServiceAccount.metadata.name,
        serviceMonitorSelector: {
          matchLabels: appLabels,
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
          matchLabels: appLabels,
        },
      },
    },
    {
      provider,
    }
  );

  const serviceMonitor = new promSdk.v1.ServiceMonitor(
    "service-monitor",
    {
      metadata: {
        labels: appLabels,
      },
      spec: {
        selector: {
          matchLabels: appLabels,
        },
        endpoints: [{ port: "web" }],
      },
    },
    {
      provider,
    }
  );

  const prometheusRule = new promSdk.v1.PrometheusRule(
    "prometheus-rule",
    {
      metadata: {
        labels: appLabels,
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
      provider,
    }
  );

  const alertmanagerConfig = new promSdk.v1alpha1.AlertmanagerConfig(
    "alertmanagerconfig",
    {
      metadata: {
        labels: appLabels,
      },
      spec: {
        route: {
          groupBy: ["job"],
          groupWait: "30s",
          groupInterval: "5m",
          repeatInterval: "12h",
          receiver: "osmc",
        },
        receivers: [
          {
            name: "osmc",
            webhookConfigs: [
              {
                url: "https://rbox.app/box/request/01216800-e1fa-4c94-a982-4f1c606dbe27",
              },
            ],
          },
        ],
      },
    },
    {
      provider,
    }
  );

  const alertManager = new promSdk.v1.Alertmanager(
    "alertmanager",
    {
      spec: {
        replicas: 3,
        alertmanagerConfigSelector: {
          matchLabels: appLabels,
        },
      },
    },
    {
      provider,
    }
  );
};

deployTheThing();
