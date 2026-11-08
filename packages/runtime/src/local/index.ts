export { ServiceError } from "../service";
export { LocalDaemonError, localDaemon } from "./daemon";
export { daemonUrl, readDaemonFile, writeDaemonFile } from "./daemon/file";
export { installDaemon, uninstallDaemon } from "./daemon/install";
export { defaultHome } from "./home";
export { Registry } from "./registry";

export { type LocalService, makeLocalService } from "./service";
