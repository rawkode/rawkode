import { Construct } from "constructs";
import { ManagedDomain, ProxyStatus } from "../dnsProvider";

export default (scope: Construct): ManagedDomain => {
	const managedDomain = new ManagedDomain(scope, "comtrya.dev");

	managedDomain
		.discourageEmail()
		.addCNameRecord("www", "hosting.gitbook.io")
		.addCNameRecord("@", "www.comtrya.dev")
		.addCNameRecord("get", "get-comtrya-dev.onrender.com")
		.addCNameRecord("schema", "comtrya-schema.pages.dev", ProxyStatus.Proxied);

	return managedDomain;
};
