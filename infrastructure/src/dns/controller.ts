import { ComponentResource } from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

export class Controller extends ComponentResource {
  readonly domainName: string;
  readonly zone: cloudflare.Zone;
  private records: cloudflare.Record[];

  constructor(domainName: string) {
    super(`rawkode:DnsController`, `${domainName}`);

    this.domainName = domainName;
    this.records = [];

    this.zone = new cloudflare.Zone(
      domainName,
      {
        zone: domainName,
        type: "full",
        plan: "free",
      },
      {
        protect: true,
        parent: this,
      }
    );
  }

  private recordName(name: string): string {
    if (name.length == 0) {
      return `${this.domainName}.`;
    }

    if (name == "@") {
      return `${this.domainName}.`;
    }

    return `${name}.${this.domainName}.`;
  }

  private resourceName(name: string, type: string): string {
    if (name.length == 0) {
      return `${this.domainName}-${type}`;
    }

    if (name == "@") {
      return `${this.domainName}-${type}`;
    }

    return `${this.domainName}-${type}-${name}`;
  }

  public createRecord(name: string, type: string, values: string[]): void {
    values.forEach((value, index) => {
      const record = new cloudflare.Record(
        this.resourceName(`${name}-${index}`, type),
        {
          zoneId: this.zone.id,
          name: this.recordName(name),
          ttl: 300,
          type,
          value,
        },
        { parent: this.zone, protect: false }
      );

      this.records.push(record);
    });

    return;
  }

  public createProxiedRecord(
    name: string,
    type: string,
    values: string[]
  ): void {
    values.forEach((value, index) => {
      const record = new cloudflare.Record(
        this.resourceName(`${name}-${index}`, type),
        {
          zoneId: this.zone.id,
          name: this.recordName(name),
          ttl: 1,
          proxied: true,
          type,
          value,
        },
        { parent: this.zone, protect: false }
      );

      this.records.push(record);
    });

    return;
  }

  public createMxRecord(name: string, priority: number, value: string): void {
    const record = new cloudflare.Record(
      this.resourceName(`${name}-${priority}`, "MX"),
      {
        zoneId: this.zone.id,
        name: this.recordName(name),
        ttl: 300,
        type: "MX",
        priority,
        value,
      },
      { parent: this.zone, protect: false }
    );

    this.records.push(record);

    return;
  }
}
