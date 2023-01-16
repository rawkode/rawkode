import { Construct } from "constructs";
import { ManagedDomain } from "../dnsProvider";

export default (scope: Construct): ManagedDomain => {
	const managedDomain = new ManagedDomain(scope, "rawkode.dev");

	managedDomain
		.enableFastmail()
		.addCNameRecord("fm1._domainkey", "fm1.rawkode.dev.dkim.fmhosted.com")
		.addCNameRecord("fm2._domainkey", "fm2.rawkode.dev.dkim.fmhosted.com")
		.addCNameRecord("fm3._domainkey", "fm3.rawkode.dev.dkim.fmhosted.com");

	return managedDomain;
};
