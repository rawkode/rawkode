import * as pulumi from "@pulumi/pulumi";

const defaultBaseUrl: string = "https://api.planetscale.com";

interface ConnectionStrings {
  prisma: string;
}

interface PlanetScalePasswordOptions {
  organization: pulumi.Input<string>;
  database: pulumi.Input<string> | pulumi.Output<string>;
  branch: pulumi.Input<string>;
  name: pulumi.Input<string>;
  token: pulumi.Output<string>;
}

interface PlanetScalePasswordInputs {
  organization: string;
  database: string | pulumi.Output<string>;
  branch: string;
  name: string;
  token: pulumi.Output<string>;
}

interface PlanetScalePasswordCreateResponse {
  id: string;
  display_name: string;
  role: string;
  plain_text: string;
  access_host_url: string;
  username: string;
  connection_strings: ConnectionStrings;
}

interface PlanetScalePasswordOutputs extends PlanetScalePasswordInputs {
  id: string;
  prismaConnectionString: string;
}

class PlanetScalePasswordProvider implements pulumi.dynamic.ResourceProvider {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  async create(
    props: PlanetScalePasswordInputs
  ): Promise<pulumi.dynamic.CreateResult> {
    const got = (await import("got")).default;

    let data = await got
      .post(
        `${defaultBaseUrl}/v1/organizations/${props.organization}/databases/${props.database}/branches/${props.branch}/passwords`,
        {
          headers: {
            Authorization: `Bearer ${props.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          json: {
            display_name: props.name,
            organization: props.organization,
            database: props.database,
            branch: props.branch,
          },
        }
      )
      .json<PlanetScalePasswordCreateResponse>();

    const outs: PlanetScalePasswordOutputs = {
      id: data.id!,
      prismaConnectionString: `mysql://${data.username}:${data.plain_text}@${data.access_host_url}/${props.database}?sslaccept=strict`,

      name: props.name,
      database: props.database,
      branch: props.branch,
      organization: props.organization,
      token: props.token,
    };

    return { id: data.id!, outs: { ...outs, ...data } };
  }

  async read(
    _: string,
    props: PlanetScalePasswordOutputs
  ): Promise<pulumi.dynamic.ReadResult> {
    const got = (await import("got")).default;

    let data = await got
      .get(
        `${defaultBaseUrl}/v1/organizations/${props.organization}/databases/${props.database}/branches/${props.branch}/passwords/${props.id}`,
        {
          headers: {
            Authorization: `Bearer ${props.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json<PlanetScalePasswordCreateResponse>();

    const outs: PlanetScalePasswordOutputs = {
      id: data.id!,
      prismaConnectionString: `mysql://${data.username}:${data.plain_text}@${data.access_host_url}/${props.database}?sslaccept=strict`,

      name: props.name,
      database: props.database,
      branch: props.branch,
      organization: props.organization,
      token: props.token,
    };

    return { id: data.id!, props: { ...outs, ...data } };
  }

  async update(
    _: string,
    olds: PlanetScalePasswordOutputs,
    news: PlanetScalePasswordOutputs
  ): Promise<pulumi.dynamic.UpdateResult> {
    return { outs: { ...olds, ...news } };
  }

  async delete(_: string, props: PlanetScalePasswordOutputs): Promise<void> {
    const got = (await import("got")).default;

    await got
      .delete(
        `${defaultBaseUrl}/v1/organizations/${props.organization}/databases/${props.database}/branches/${props.branch}/passwords/${props.name}`,
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

export class PlanetScalePassword extends pulumi.dynamic.Resource {
  public readonly username!: pulumi.Output<string>;
  public readonly prismaConnectionString!: pulumi.Output<string>;

  constructor(
    name: string,
    props: PlanetScalePasswordOptions,
    opts?: pulumi.CustomResourceOptions
  ) {
    super(
      new PlanetScalePasswordProvider(name),
      name,
      { username: undefined, prismaConnectionString: undefined, ...props },
      opts
    );
  }
}
