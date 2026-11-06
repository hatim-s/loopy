import type { RouteDependencies } from "../../service";
import { apiRoutes as portableRoutes } from "../../service";

export { dispatch, errorResponse, json } from "../../service";

export function apiRoutes(
  options: Omit<RouteDependencies, "daemon"> & {
    daemon: Omit<RouteDependencies["daemon"], "pid">;
  },
) {
  return portableRoutes({ ...options, daemon: { ...options.daemon, pid: process.pid } });
}
