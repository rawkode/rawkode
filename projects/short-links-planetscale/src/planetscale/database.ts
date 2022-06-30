import * as pulumi from "@pulumi/pulumi";

const defaultBaseUrl: string = "https://api.planetscale.com";

interface PlanetScaleDatabaseInputs {
  organization: string;
  name: string;
  region: string;
  token: pulumi.Output<string>;
}

interface PlanetScaleDatabaseCreateResponse {
  id: string;
  name: string;
}

interface PlanetScaleDatabaseOutputs {
  id: string;
  name: string;
  organization: string;
  region: string;
  token: pulumi.Output<string>;
}

class PlanetScaleDatabaseProvider implements pulumi.dynamic.ResourceProvider {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  async create(
    props: PlanetScaleDatabaseInputs
  ): Promise<pulumi.dynamic.CreateResult> {
    const got = (await import("got")).default;

    let data = await got
      .post(
        `${defaultBaseUrl}/v1/organizations/${props.organization}/databases`,
        {
          headers: {
            Authorization: `Bearer ${props.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          json: {
            organization: props.organization,
            name: props.name,
            region: props.region,
          },
        }
      )
      .json<PlanetScaleDatabaseOutputs>();

    const outs: PlanetScaleDatabaseOutputs = {
      id: data.id!,
      name: data.name!,
      region: props.region,
      organization: props.organization,
      token: props.token,
    };

    return { id: data.id!, outs };
  }

  async read(
    _: string,
    props: PlanetScaleDatabaseOutputs
  ): Promise<pulumi.dynamic.ReadResult> {
    const got = (await import("got")).default;

    let data = await got
      .get(
        `${defaultBaseUrl}/v1/organizations/${props.organization}/databases/${props.name}`,
        {
          headers: {
            Authorization: `Bearer ${props.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json<PlanetScaleDatabaseCreateResponse>();

    const outs: PlanetScaleDatabaseOutputs = {
      region: props.region,
      organization: props.organization,
      token: props.token,
      ...data,
    };

    return { id: data.id!, props: outs };
  }

  async update(
    _: string,
    olds: PlanetScaleDatabaseOutputs,
    news: PlanetScaleDatabaseOutputs
  ): Promise<pulumi.dynamic.UpdateResult> {
    return { outs: { ...olds, ...news } };
  }

  async delete(id: string, props: PlanetScaleDatabaseOutputs): Promise<void> {
    const got = (await import("got")).default;

    await got
      .delete(
        `${defaultBaseUrl}/v1/organizations/${props.organization}/databases/${props.name}`,
        {
          headers: {
            Authorization: `Bearer ${props.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json();

    return;
  }
}

export class PlanetScaleDatabase extends pulumi.dynamic.Resource {
  public readonly name: pulumi.Output<string>;
  public readonly organization: pulumi.Output<string>;
  public readonly region: pulumi.Output<string>;

  constructor(
    name: string,
    props: PlanetScaleDatabaseInputs,
    opts?: pulumi.CustomResourceOptions
  ) {
    super(new PlanetScaleDatabaseProvider(name), name, props, opts);
  }
}
