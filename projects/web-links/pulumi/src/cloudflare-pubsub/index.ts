import * as pulumi from "@pulumi/pulumi";

const defaultBaseUrl: string = "https://api.cloudflare.com/client/v4/accounts";

// curl -s -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pubsub/namespaces" --data '{"name": "my-namespace" }'

interface CloudflarePubSubInputs {
  accountId: string;
  apiToken: string;
  namespace: string;
  topic: string;
}

interface CloudflarePubSubNamespaceResponse {
  result: {
    id: string;
    name: string;
    description: string;
    created_on: string;
    modified_on: string;
  };
  success: boolean;
  errors: string[];
  messages: string[];
}

interface CloudflarePubSubBrokerResponse {
  result: {
    id: string;
    name: string;
    authType: string;
    endpoint: string;
    created_on: string;
    expiration: string;
    modified_on: string;
  };
  success: boolean;
  errors: string[];
  messages: string[];
}

interface CloudflarePubSubCredentialsResponse {
  result: {
    [name: string]: string;
  };
  success: boolean;
  errors: string[];
  messages: string[];
}

interface CloudflarePubSubOutputs {
  namespace: string;
  topic: string;
  description: string;

  endpoint: string;
  username: string;
  password: string;

  accountId: string;
  apiToken: string;
}

class CloudflarePubSubProvider implements pulumi.dynamic.ResourceProvider {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  async create(
    props: CloudflarePubSubInputs
  ): Promise<pulumi.dynamic.CreateResult> {
    const got = (await import("got")).default;

    let namespace = await got
      .post(`${defaultBaseUrl}/${props.accountId}/pubsub/namespaces`, {
        headers: {
          Authorization: `Bearer ${props.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        json: {
          name: props.namespace,
        },
      })
      .json<CloudflarePubSubNamespaceResponse>();

    if (!namespace.success) {
      throw new Error(
        `Failed to create namespace: ${namespace.errors.join(",")}`
      );
    }

    let topic = await got
      .post(
        `${defaultBaseUrl}/${props.accountId}/pubsub/namespaces/${namespace.result.name}/brokers`,
        {
          headers: {
            Authorization: `Bearer ${props.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          json: {
            name: props.topic,
            authType: "TOKEN",
          },
        }
      )
      .json<CloudflarePubSubBrokerResponse>();

    if (!topic.success) {
      throw new Error(`Failed to create topic: ${namespace.errors.join(",")}`);
    }

    let credentials = await got
      .get(
        `${defaultBaseUrl}/${props.accountId}/pubsub/namespaces/${namespace.result.name}/brokers/${topic.result.name}/credentials?number=1&type=TOKEN&topicAcl=#`,
        {
          headers: {
            Authorization: `Bearer ${props.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json<CloudflarePubSubCredentialsResponse>();

    if (!credentials.success) {
      throw new Error(
        `Failed to create credentials: ${namespace.errors.join(",")}`
      );
    }

    const creds = Object.entries(credentials.result).pop();
    if (creds === undefined) {
      throw new Error("Failed to get token");
    }

    const outs: CloudflarePubSubOutputs = {
      namespace: namespace.result.name!,
      topic: topic.result.name!,

      description: "",

      endpoint: topic.result.endpoint!,
      username: creds[0]!,
      password: creds[1]!,

      apiToken: props.apiToken,
      accountId: props.accountId,
    };

    return { id: `${props.accountId}-${props.namespace}-${props.topic}`, outs };
  }

  async update(
    _: string,
    olds: CloudflarePubSubOutputs,
    news: CloudflarePubSubOutputs
  ): Promise<pulumi.dynamic.UpdateResult> {
    return { outs: { ...olds, ...news } };
  }

  async read(
    id: string,
    props: CloudflarePubSubOutputs
  ): Promise<pulumi.dynamic.ReadResult> {
    const got = (await import("got")).default;

    let namespace = await got
      .get(
        `${defaultBaseUrl}/${props.accountId}/pubsub/namespaces/${props.namespace}`,
        {
          headers: {
            Authorization: `Bearer ${props.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json<CloudflarePubSubNamespaceResponse>();

    if (!namespace.success) {
      throw new Error(`Failed to get namespace: ${namespace.errors.join(",")}`);
    }

    let topic = await got
      .get(
        `${defaultBaseUrl}/${props.accountId}/pubsub/namespaces/${props.namespace}/brokers/${props.topic}`,
        {
          headers: {
            Authorization: `Bearer ${props.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json<CloudflarePubSubBrokerResponse>();

    if (!topic.success) {
      throw new Error(`Failed to get topic: ${namespace.errors.join(",")}`);
    }

    const outs: CloudflarePubSubOutputs = {
      namespace: namespace.result.name!,
      topic: topic.result.name!,

      description: "",

      endpoint: topic.result.endpoint!,
      username: props.username!,
      password: props.password!,

      accountId: props.accountId!,
      apiToken: props.apiToken!,
    };

    return {
      id,
      props: outs,
    };
  }

  async delete(_id: string, props: CloudflarePubSubOutputs): Promise<void> {
    const got = (await import("got")).default;

    let topic = await got
      .delete(
        `${defaultBaseUrl}/${props.accountId}/pubsub/namespaces/${props.namespace}/brokers/${props.topic}`,
        {
          headers: {
            Authorization: `Bearer ${props.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json<CloudflarePubSubBrokerResponse>();

    if (!topic.success) {
      throw new Error(`Failed to get topic: ${topic.errors.join(",")}`);
    }

    let namespace = await got
      .delete(
        `${defaultBaseUrl}/${props.accountId}/pubsub/namespaces/${props.namespace}`,
        {
          headers: {
            Authorization: `Bearer ${props.apiToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      )
      .json<CloudflarePubSubNamespaceResponse>();

    if (!namespace.success) {
      throw new Error(`Failed to get namespace: ${namespace.errors.join(",")}`);
    }

    return;
  }
}

export class CloudflarePubSub extends pulumi.dynamic.Resource {
  public readonly namespace: pulumi.Output<string>;
  public readonly topic: pulumi.Output<string>;
  public readonly endpoint: pulumi.Output<string>;
  public readonly username: pulumi.Output<string>;
  public readonly password: pulumi.Output<string>;

  constructor(
    name: string,
    props: CloudflarePubSubInputs,
    opts?: pulumi.CustomResourceOptions
  ) {
    super(
      new CloudflarePubSubProvider(name),
      name,
      {
        endpoint: undefined,
        username: undefined,
        password: undefined,
        ...props,
      },
      opts
    );
  }
}
