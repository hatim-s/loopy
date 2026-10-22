import type { RouteDependencies } from "../../service/index.js";
import { apiRoutes as portableRoutes } from "../../service/index.js";

export { dispatch, errorResponse, json } from "../../service/index.js";

export function apiRoutes(
  options: Omit<RouteDependencies, "daemon"> & {
    daemon: Omit<RouteDependencies["daemon"], "pid">;
  },
) {
  return portableRoutes({ ...options, daemon: { ...options.daemon, pid: process.pid } });
}
