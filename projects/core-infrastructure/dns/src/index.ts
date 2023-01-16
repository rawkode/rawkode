import { CloudflareProvider } from "@generatedProviders/cloudflare/provider";
import { GandiProvider } from "@generatedProviders/gandi/provider";
import { App, CloudBackend, NamedCloudWorkspace, TerraformStack } from "cdktf";
import { Construct } from "constructs";
import chappaaiDev from "./domains/chappaai.dev";
import comtryaDev from "./domains/comtrya.dev";
import profundumCoUk from "./domains/profundum.co.uk";
import rawkodeDev from "./domains/rawkode.dev";
import rawkodeEmail from "./domains/rawkode.email";

class CoreDns extends TerraformStack {
	constructor(scope: Construct, id: string) {
		super(scope, id);

		new CloudflareProvider(this, "cloudflare", {
			apiToken: process.env.CLOUDFLARE_API_TOKEN || "",
		});

		new GandiProvider(this, "gandi", {
			key: process.env.GANDI_KEY || "",
		});

		chappaaiDev(this);
		comtryaDev(this);
		profundumCoUk(this);
		rawkodeDev(this);
		rawkodeEmail(this);
	}
}

const app = new App();
const stack = new CoreDns(app, "dns");

new CloudBackend(stack, {
	hostname: "app.terraform.io",
	organization: "rawkode",
	workspaces: new NamedCloudWorkspace("core-dns"),
});

app.synth();
