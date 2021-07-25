import { ComponentResource } from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

export class Controller extends ComponentResource {
  readonly domainName: string;
  readonly zone: Promise<cloudflare.types.output.GetZonesZone>;
  private records: cloudflare.Record[];

  constructor(domainName: string) {
    super(`rawkode:DnsController`, `${domainName}`);

    this.domainName = domainName;
    this.records = [];

    this.zone = cloudflare
      .getZones({
        filter: {
          name: this.domainName,
        },
      })
      .then((result) => {
        if (result.zones.length === 0) {
          throw new Error(`No zone found for domain ${domainName}`);
        }

        const zone = result.zones.shift();

        if (zone === undefined) {
          throw new Error(`No zone found for domain ${domainName}`);
        }

        return zone;
      });
  }

  private recordName(name: string): string {
    if (name.length == 0) {
      return this.domainName;
    }

    return `${name}.${this.domainName}`;
  }

  private resourceName(name: string): string {
    if (name.length == 0) {
      return this.domainName;
    }

    return `${this.domainName}-${name}`;
  }

  public async createRecord(
    name: string,
    type: string,
    value: string
  ): Promise<cloudflare.Record> {
    const zone = await this.zone.then((zone) => zone);

    if (zone.id === undefined || zone.name === undefined) {
      throw new Error("Failed");
    }

    const record = new cloudflare.Record(
      this.resourceName(name),
      {
        name: this.recordName(name),
        type: type,
        zoneId: zone.id,
        ttl: 300,
        value: value,
      },
      {
        parent: this,
      }
    );

    this.records.push(record);

    return record;
  }
}
