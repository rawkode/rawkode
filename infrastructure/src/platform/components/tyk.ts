import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

import { Component, ComponentArgs } from "./abstract";
import { CertManager } from "./certManager";

export class Tyk extends Component {
  protected readonly version = "0.9.4";
  protected readonly operatorVersion = "0.8.1";
  protected readonly redisVersion = "16.3.1";

  protected readonly _apiToken: random.RandomPassword;
  protected readonly _orgId: random.RandomUuid;
  protected readonly _redisPassword: random.RandomPassword;

  protected readonly crdsUrl =
    "https://raw.githubusercontent.com/TykTechnologies/tyk-operator/v${VERSION}/helm/crds/crds.yaml";

  static getComponentName(): string {
    return "tyk";
  }

  static getDependencies(): string[] {
    return [CertManager.getComponentName()];
  }

  constructor(name: string, args: ComponentArgs) {
    super(name, args);

    const crds = new kubernetes.yaml.ConfigFile(
      `${this.name}-crds`,
      {
        file: this.crdsUrl.replace("${VERSION}", this.operatorVersion),
      },
      { provider: this.provider, parent: this }
    );

    this._apiToken = new random.RandomPassword(
      `${this.name}-api-secret`,
      {
        length: 32,
      },
      {
        parent: this,
      }
    );
    this.resources.push(this._apiToken);

    this._orgId = new random.RandomUuid("tyk-org-id", {}, { parent: this });
    this.resources.push(this._orgId);

    this._redisPassword = new random.RandomPassword(
      `${this.name}-redis-password`,
      {
        length: 32,
      },
      { parent: this }
    );
    this.resources.push(this._redisPassword);

    const redis = new kubernetes.helm.v3.Release(
      this.name,
      {
        chart: "redis",
        repositoryOpts: {
          repo: "https://charts.bitnami.com/bitnami",
        },
        skipAwait: true,
        version: this.redisVersion,
        namespace: args.namespace,
        values: {
          auth: {
            password: this._redisPassword.result,
          },
        },
      },
      {
        provider: args.provider,
        parent: this,
      }
    );
    this.resources.push(redis);

    const redisService = kubernetes.core.v1.Service.get(
      `${this.name}-redis-service`,
      pulumi.interpolate`${redis.status.namespace}/${redis.status.name}-redis-master`,
      {
        provider: args.provider,
        parent: this,
        dependsOn: [redis],
      }
    );
    this.resources.push(redisService);

    const gateway = new kubernetes.helm.v3.Release(
      `${this.name}-gateway`,
      {
        chart: "tyk-headless",
        repositoryOpts: {
          repo: "https://helm.tyk.io/public/helm/charts/",
        },
        skipAwait: true,
        version: this.version,
        namespace: args.namespace,
        values: {
          gateway: {
            tls: "true",
          },
          secrets: {
            APISecret: pulumi.interpolate`${this._apiToken.result}`,
            OrgID: pulumi.interpolate`${this._orgId.result}`,
          },
          redis: {
            addrs: [
              pulumi.interpolate`${redisService.metadata.name}.${redisService.metadata.namespace}.svc.cluster.local:6379`,
            ],
            pass: pulumi.interpolate`${this._redisPassword.result}`,
          },
        },
      },
      {
        provider: args.provider,
        parent: this,
        dependsOn: [redis, redisService],
      }
    );
    this.resources.push(gateway);

    const gatewayService = kubernetes.core.v1.Service.get(
      `${name}-gateway-service`,
      pulumi.interpolate`${gateway.status.namespace}/gateway-svc-${gateway.status.name}-tyk-headless`,
      {
        provider: args.provider,
        parent: this,
        dependsOn: [redis, gateway],
      }
    );
    this.resources.push(gatewayService);

    const operatorConfig = new kubernetes.core.v1.Secret(
      `${name}-operator-config`,
      {
        metadata: {
          name: "tyk-operator-conf",
          namespace: args.namespace,
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        stringData: {
          TYK_AUTH: pulumi.interpolate`${this._apiToken.result}`,
          TYK_ORG: pulumi.interpolate`${this._orgId.result}`,
          TYK_URL: pulumi.interpolate`https://${gatewayService.metadata.name}.${gatewayService.metadata.namespace}.svc.cluster.local`,
          TYK_TLS_INSECURE_SKIP_VERIFY: "true",
          TYK_MODE: "ce",
        },
      },
      {
        provider: args.provider,
        parent: this,
      }
    );

    const operator = new kubernetes.helm.v3.Release(
      `${name}-operator`,
      {
        chart: "tyk-operator",
        repositoryOpts: {
          repo: "https://helm.tyk.io/public/helm/charts/",
        },
        skipAwait: true,
        version: this.operatorVersion,
        namespace: args.namespace,
        values: {
          envFrom: [
            {
              secretRef: {
                name: pulumi.interpolate`${operatorConfig.metadata.name}`,
              },
            },
          ],
        },
      },
      {
        provider: args.provider,
        parent: this,
        dependsOn: [crds, operatorConfig, gatewayService],
      }
    );
  }

  public get apiToken(): pulumi.Output<string> {
    return this._apiToken.result;
  }

  public get orgId(): pulumi.Output<string> {
    return this._orgId.result;
  }

  public get redisPassword(): pulumi.Output<string> {
    return this._redisPassword.result;
  }
}
