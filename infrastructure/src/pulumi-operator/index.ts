import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

export const install = (
  provider: kubernetes.Provider,
  namespace: pulumi.Output<string>
): kubernetes.apps.v1.Deployment => {
  const crds = new kubernetes.yaml.ConfigFile(
    "crds",
    {
      file: "https://raw.githubusercontent.com/pulumi/pulumi-kubernetes-operator/v1.4.0/deploy/crds/pulumi.com_stacks.yaml",
    },
    {
      provider,
    }
  );

  const operatorServiceAccount = new kubernetes.core.v1.ServiceAccount(
    "pulumi-operator-service-account",
    {
      metadata: {
        namespace,
      },
    },
    {
      provider,
    }
  );

  const operatorRole = new kubernetes.rbac.v1.Role(
    "pulumi-operator-role",
    {
      metadata: {
        namespace,
      },
      rules: [
        {
          apiGroups: [""],
          resources: [
            "pods",
            "services",
            "services/finalizers",
            "endpoints",
            "persistentvolumeclaims",
            "events",
            "configmaps",
            "secrets",
          ],
          verbs: [
            "create",
            "delete",
            "get",
            "list",
            "patch",
            "update",
            "watch",
          ],
        },
        {
          apiGroups: ["apps"],
          resources: [
            "deployments",
            "daemonsets",
            "replicasets",
            "statefulsets",
          ],
          verbs: [
            "create",
            "delete",
            "get",
            "list",
            "patch",
            "update",
            "watch",
          ],
        },
        {
          apiGroups: ["monitoring.coreos.com"],
          resources: ["servicemonitors"],
          verbs: ["create", "get"],
        },
        {
          apiGroups: ["apps"],
          resourceNames: ["pulumi-kubernetes-operator"],
          resources: ["deployments/finalizers"],
          verbs: ["update"],
        },
        {
          apiGroups: [""],
          resources: ["pods"],
          verbs: ["get"],
        },
        {
          apiGroups: ["apps"],
          resources: ["replicasets", "deployments"],
          verbs: ["get"],
        },
        {
          apiGroups: ["pulumi.com"],
          resources: ["*"],
          verbs: [
            "create",
            "delete",
            "get",
            "list",
            "patch",
            "update",
            "watch",
          ],
        },
        {
          apiGroups: ["coordination.k8s.io"],
          resources: ["leases"],
          verbs: ["create", "get", "list", "update"],
        },
        {
          apiGroups: ["projectcontour.io"],
          resources: ["*"],
          verbs: ["*"],
        },
      ],
    },
    {
      provider,
    }
  );

  const operatorRoleBinding = new kubernetes.rbac.v1.RoleBinding(
    "pulumi-operator-role-binding",
    {
      metadata: {
        namespace,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: operatorServiceAccount.metadata.name,
        },
      ],
      roleRef: {
        kind: "Role",
        name: operatorRole.metadata.name,
        apiGroup: "rbac.authorization.k8s.io",
      },
    },
    {
      provider,
    }
  );

  const operatorDeployment = new kubernetes.apps.v1.Deployment(
    "pulumi-kubernetes-operator",
    {
      metadata: {
        namespace,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            name: "pulumi-kubernetes-operator",
          },
        },
        template: {
          metadata: {
            labels: {
              name: "pulumi-kubernetes-operator",
            },
          },
          spec: {
            serviceAccountName: operatorServiceAccount.metadata.name,
            containers: [
              {
                name: "pulumi-kubernetes-operator",
                image: "pulumi/pulumi-kubernetes-operator:v1.4.0",
                args: ["--zap-level=error", "--zap-time-encoding=iso8601"],
                imagePullPolicy: "Always",
                env: [
                  {
                    name: "WATCH_NAMESPACE",
                    valueFrom: {
                      fieldRef: {
                        fieldPath: "metadata.namespace",
                      },
                    },
                  },
                  {
                    name: "POD_NAME",
                    valueFrom: {
                      fieldRef: {
                        fieldPath: "metadata.name",
                      },
                    },
                  },
                  {
                    name: "OPERATOR_NAME",
                    value: "pulumi-kubernetes-operator",
                  },
                  {
                    name: "GRACEFUL_SHUTDOWN_TIMEOUT_DURATION",
                    value: "5m",
                  },
                  {
                    name: "MAX_CONCURRENT_RECONCILES",
                    value: "10",
                  },
                  {
                    name: "PULUMI_INFER_NAMESPACE",
                    value: "1",
                  },
                ],
              },
            ],
            // Should be same or larger than GRACEFUL_SHUTDOWN_TIMEOUT_DURATION
            terminationGracePeriodSeconds: 300,
          },
        },
      },
    },
    {
      provider,
      dependsOn: crds,
    }
  );

  return operatorDeployment;
};
