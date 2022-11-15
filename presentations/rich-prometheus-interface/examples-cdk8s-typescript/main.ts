import { Construct } from "constructs";
import { App, Chart, ChartProps } from "cdk8s";
import { KubeDeployment, KubeService } from "./imports/k8s";
import * as promSdk from "./imports/monitoring.coreos.com";

export class MyChart extends Chart {
  constructor(scope: Construct, id: string, props: ChartProps = {}) {
    super(scope, id, props);

    const appLabels = { app: "osmc" };

    const app = new KubeDeployment(this, "our-app", {
      metadata: {
        labels: appLabels,
      },
      spec: {
        selector: {
          matchLabels: appLabels,
        },
        template: {
          spec: {
            containers: [
              {
                name: "app",
                image: "fabxc/instrumented_app",
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
    });

    const service = new KubeService(this, "our-app", {
      spec: {
        selector: appLabels,
        ports: [
          {
            name: "web",
            port: 8080,
          },
        ],
      },
    });

    const prometheus = new promSdk.Prometheus(this, "prometheus", {
      spec: {
        replicas: 3,
        serviceMonitorSelector: {
          matchLabels: appLabels,
        },
        alerting: {
          alertmanagers: [
            {
              namespace: "default",
              name: "alertmanager-main",
              port: promSdk.PrometheusSpecAlertingAlertmanagersPort.fromString(
                "web"
              ),
            },
          ],
        },
        ruleSelector: {
          matchLabels: appLabels,
        },
        ruleNamespaceSelector: {
          matchLabels: appLabels,
        },
      },
    });

    const serviceMonitor = new promSdk.ServiceMonitor(this, "service-monitor", {
      metadata: {
        labels: appLabels,
      },
      spec: {
        selector: {
          matchLabels: appLabels,
        },
        endpoints: [{ port: "web" }],
      },
    });

    const alertManager = new promSdk.Alertmanager(this, "alertmanager", {
      spec: {
        replicas: 3,
        alertmanagerConfigSelector: {
          matchLabels: {
            alertmanagerConfig: "osmc",
          },
        },
      },
    });

    const alertmanagerConfig = new promSdk.AlertmanagerConfig(
      this,
      "alertmanagerConfig",
      {
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
      }
    );
  }
}

const app = new App();
new MyChart(app, "examples-cdk8s-typescript");
app.synth();
