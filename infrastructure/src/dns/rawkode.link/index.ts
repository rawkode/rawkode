import { Controller } from "../controller";

const DOMAIN = "rawkode.link";

const zone = new Controller(DOMAIN);
zone.disableEmail();

export default zone;
