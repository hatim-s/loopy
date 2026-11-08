import type { AttemptDependencies } from "../attempt/dependencies";
import { FilesystemAuthority } from "./authority";
import { FilesystemResults } from "./results";

export function filesystemStorage(
  stateRoot: string,
): Pick<AttemptDependencies, "authority" | "resultsFor" | "close"> {
  const authority = new FilesystemAuthority(stateRoot);

  return {
    authority,
    resultsFor: (workspace) => new FilesystemResults(stateRoot, workspace),
    close: () => authority.close(),
  };
}
