import { Controller } from "../controller";

const domainController = new Controller("rawkode.dev");

domainController.createRecord("test", "A", "192.168.0.1");

export default domainController;
