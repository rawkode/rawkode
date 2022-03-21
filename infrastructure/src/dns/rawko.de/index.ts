import { Controller } from "../controller";

const DOMAIN = "rawko.de";

const zone = new Controller(DOMAIN);

zone.createRecord("@", "A", ["18.184.197.212", "52.59.165.42"]);
zone.createRecord("i", "CNAME", ["custom.getcloudapp.com"]);
zone.disableEmail();

export default zone;
