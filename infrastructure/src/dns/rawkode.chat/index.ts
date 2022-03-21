import { Controller } from "../controller";

const DOMAIN = "rawkode.chat";

const zone = new Controller(DOMAIN);

zone.createRecord("@", "A", ["18.184.197.212", "52.59.165.42"]);
zone.disableEmail();

export default zone;
