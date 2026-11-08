// Request body ceilings for each HTTP host. Saves carry compiled bundles, so both exceed the
// per-artifact limits they wrap. The sandbox ceilings live with the sandbox wire schemas.
export const LOCAL_MAX_REQUEST_BYTES = 64 * 1024 * 1024;

export const CLOUD_MAX_REQUEST_BYTES = 24 * 1024 * 1024;
