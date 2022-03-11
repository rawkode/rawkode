import { RandomPassword } from "@pulumi/random";
import * as kubernetes from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as slug from "slug";

import { Controller, getController } from "../../dns";

interface ProjectArgs {
  rootDomainName: string;
  platformDependency: pulumi.Resource | Promise<pulumi.Resource>;
  provider: kubernetes.Provider;
}

export class Project extends pulumi.ComponentResource {
  private domainController: Controller;
  private namespace: kubernetes.core.v1.Namespace;
  private configMap: kubernetes.core.v1.ConfigMap;
  private operatorServiceAccount: kubernetes.core.v1.ServiceAccount;
  private operatorRole: kubernetes.rbac.v1.Role;
  private operatorRoleBinding: kubernetes.rbac.v1.RoleBinding;
  private stackSecret: RandomPassword;
  private persistentVolumeClaim: kubernetes.core.v1.PersistentVolumeClaim;
  private operator: kubernetes.apps.v1.Deployment;
  private pulumiKubernetesSecret: kubernetes.core.v1.Secret;
  private stack: kubernetes.apiextensions.CustomResource;

  constructor(name: string, args: ProjectArgs) {
    super("rawkode:platform:Project", name, args, {});

    const slugName = slug(name);
    const provider = args.provider;

    this.domainController = getController(args.rootDomainName);

    this.namespace = new kubernetes.core.v1.Namespace(
      slugName,
      {
        // Disable auto-naming on this namespace for consistent experience for developers
        metadata: {
          name,
        },
      },
      { provider }
    );
    const namespace = this.namespace.metadata.name;

    this.configMap = new kubernetes.core.v1.ConfigMap(
      `${slugName}-environment`,
      {
        metadata: {
          namespace,
          name: "environment",
        },
        data: {
          domain: this.domainController.domainName,
        },
      },
      {
        provider,
      }
    );

    this.operatorServiceAccount = new kubernetes.core.v1.ServiceAccount(
      `${slugName}-pulumi-operator-service-account`,
      {
        metadata: {
          namespace,
        },
      },
      {
        provider,
      }
    );

    this.operatorRole = new kubernetes.rbac.v1.Role(
      `${slugName}-pulumi-operator-role`,
      {
        metadata: {
          namespace,
        },
        rules: [
          {
            apiGroups: ["*"],
            resources: ["*"],
            verbs: ["*"],
          },
        ],
      },
      {
        provider,
      }
    );

    this.operatorRoleBinding = new kubernetes.rbac.v1.RoleBinding(
      `${slugName}-pulumi-operator-role-binding`,
      {
        metadata: {
          namespace,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: this.operatorServiceAccount.metadata.name,
          },
        ],
        roleRef: {
          kind: "Role",
          name: this.operatorRole.metadata.name,
          apiGroup: "rbac.authorization.k8s.io",
        },
      },
      {
        provider,
      }
    );

    const operatorName = `${slugName}-operator`;

    this.stackSecret = new RandomPassword(`${slugName}-pulumi-stack-secret`, {
      length: 32,
    });

    this.pulumiKubernetesSecret = new kubernetes.core.v1.Secret(
      `${slugName}-password`,
      {
        metadata: {
          namespace,
        },
        stringData: {
          password: this.stackSecret.result,
        },
      },
      {
        provider,
      }
    );

    this.persistentVolumeClaim = new kubernetes.core.v1.PersistentVolumeClaim(
      `${slugName}-operator`,
      {
        metadata: {
          namespace,
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: {
            requests: {
              storage: "10Gi",
            },
          },
        },
      },
      {
        provider,
      }
    );

    this.operator = new kubernetes.apps.v1.Deployment(
      `${slugName}-pulumi-kubernetes-operator`,
      {
        metadata: {
          namespace,
        },
        spec: {
          replicas: 1,

          selector: {
            matchLabels: {
              name: operatorName,
            },
          },

          template: {
            metadata: {
              labels: {
                name: operatorName,
              },
            },
            spec: {
              serviceAccountName: this.operatorServiceAccount.metadata.name,
              volumes: [
                {
                  name: "state",
                  persistentVolumeClaim: {
                    claimName: this.persistentVolumeClaim.metadata.name,
                  },
                },
              ],
              securityContext: {
                fsGroup: 1000,
              },
              containers: [
                {
                  name: "operator",
                  image: "pulumi/pulumi-kubernetes-operator:v1.4.0",
                  args: ["--zap-level=error", "--zap-time-encoding=iso8601"],
                  imagePullPolicy: "Always",
                  volumeMounts: [
                    {
                      name: "state",
                      mountPath: "/state",
                    },
                  ],
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
                      value: `${slugName}-operator`,
                    },
                    {
                      name: "GRACEFUL_SHUTDOWN_TIMEOUT_DURATION",
                      value: "5m",
                    },
                    {
                      name: "MAX_CONCURRENT_RECONCILES",
                      value: "1",
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
        dependsOn: [this.operatorRoleBinding, args.platformDependency],
      }
    );

    this.stack = new kubernetes.apiextensions.CustomResource(
      `${slugName}-stack`,
      {
        apiVersion: "pulumi.com/v1",
        kind: "Stack",
        metadata: {
          namespace,
        },
        spec: {
          stack: `${this.domainController}-${slugName}`,
          projectRepo: "https://github.com/rawkode-academy/platform",
          branch: "refs/heads/main",
          destroyOnFinalize: true,
          backend: "file:///state",
          envRefs: {
            PULUMI_CONFIG_PASSPHRASE: {
              type: "Secret",
              secret: {
                namespace,
                name: this.pulumiKubernetesSecret.metadata.name,
                key: "password",
              },
            },
          },
        },
      },
      {
        provider,
        dependsOn: [this.operator, this.configMap],
      }
    );

    this.registerOutputs({
      namespaceName: this.namespace.metadata.name,
    });
  }

  public get stackName(): pulumi.Output<string> {
    return this.stack.metadata.name;
  }
}
