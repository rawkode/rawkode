import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import * as k8x from "@pulumi/kubernetesx";

import { Cluster } from "../../cluster";
import { Controller } from "../../dns/controller";
import { PersistentVolumeClaim } from "@pulumi/kubernetes/core/v1";
import { RandomPassword } from "@pulumi/random";

// TODO: This should be a ComponentResource
interface Args {
  provider: kubernetes.Provider;
  domainController: Controller;
}

interface Project {
  name: pulumi.Input<string>;
  org: pulumi.Input<string>;
  repository: pulumi.Input<string>;
  reference: pulumi.Input<string>;
  accessToken: pulumi.Input<string>;
}

export const installProjects = async (args: Args) => {
  const config = new pulumi.Config();
  const projects: Project[] = config.requireObject("projects");

  const crds = new kubernetes.yaml.ConfigFile(
    "crds",
    {
      file: "https://raw.githubusercontent.com/pulumi/pulumi-kubernetes-operator/v1.4.0/deploy/crds/pulumi.com_stacks.yaml",
    },
    {
      provider: args.provider,
    }
  );

  projects.forEach((project) => provisionProject(project, args, crds));
};

const provisionProject = async (
  project: Project,
  args: Args,
  dependsOn: kubernetes.yaml.ConfigFile
): Promise<void> => {
  // Needs to be default until a new release is cut:
  // https://github.com/pulumi/pulumi-kubernetes/pull/1896
  const namespace = "default";

  const projectContract = new kubernetes.core.v1.ConfigMap(
    `${project.name}-environment`,
    {
      metadata: {
        namespace,
        name: "environment",
      },
      data: {
        domain: args.domainController.domainName,
      },
    },
    {
      provider: args.provider,
    }
  );

  const operatorServiceAccount = new kubernetes.core.v1.ServiceAccount(
    `${project.name}-pulumi-operator-service-account`,
    {
      metadata: {
        namespace,
      },
    },
    {
      provider: args.provider,
    }
  );

  const operatorRole = new kubernetes.rbac.v1.Role(
    `${project.name}-pulumi-operator-role`,
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
      provider: args.provider,
    }
  );

  const operatorRoleBinding = new kubernetes.rbac.v1.RoleBinding(
    `${project.name}-pulumi-operator-role-binding`,
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
      provider: args.provider,
    }
  );

  const operatorName = `${project.name}-operator`;

  const pulumiStackSecret = new RandomPassword(
    `${project.name}-pulumi-stack-secret`,
    {
      length: 32,
    }
  );

  const pulumiKubernetesSecret = new kubernetes.core.v1.Secret(
    `${project.name}-password`,
    {
      metadata: {
        namespace,
      },
      stringData: {
        password: pulumiStackSecret.result,
      },
    },
    {
      provider: args.provider,
    }
  );

  const persistentVolume = new PersistentVolumeClaim(
    `${project.name}-operator`,
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
      provider: args.provider,
    }
  );

  const operator = new kubernetes.apps.v1.Deployment(
    `${project.name}-pulumi-kubernetes-operator`,
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
            serviceAccountName: operatorServiceAccount.metadata.name,
            volumes: [
              {
                name: "state",
                persistentVolumeClaim: {
                  claimName: persistentVolume.metadata.name,
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
                    value: `${project.name}-operator`,
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
      provider: args.provider,
      dependsOn,
    }
  );

  new kubernetes.apiextensions.CustomResource(
    `${project.name}-stack`,
    {
      apiVersion: "pulumi.com/v1",
      kind: "Stack",
      metadata: {
        namespace,
      },
      spec: {
        stack: `${args.domainController.domainName}-${project.name}`,
        projectRepo: "https://github.com/rawkode-academy/platform",
        branch: "refs/heads/main",
        destroyOnFinalize: true,
        backend: "file:///state",
        envRefs: {
          PULUMI_CONFIG_PASSPHRASE: {
            type: "Secret",
            secret: {
              name: pulumiKubernetesSecret.metadata.name,
              namespace: pulumiKubernetesSecret.metadata.namespace,
              key: "password",
            },
          },
        },
      },
    },
    {
      provider: args.provider,
      dependsOn: [operator],
    }
  );
};
