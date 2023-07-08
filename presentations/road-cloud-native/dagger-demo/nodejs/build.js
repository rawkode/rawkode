import Client, { connect } from "@dagger.io/dagger";

connect(
  async (client) => {
    const node = client.container().from("node:16").withExec(["node", "-v"]);

    const version = await node.stdout();

    const stepTwo = client
      .container()
      .from("node:16")
      .withEnvVariable("VERSION", version)
      .withExec(["node", "-v"]);

    console.log("Hello from Dagger and Node " + version);

    console.log(await stepTwo.stdout());
  },
  {
    LogOutput: process.stdout,
  }
);
