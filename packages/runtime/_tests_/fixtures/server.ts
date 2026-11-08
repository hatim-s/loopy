import { makeLocalService } from "../../src/local";
import { fixture, save } from "./project";
import { fixtureStore } from "./service-runtime";

/** A saved one-node loopy with its store and a local service over them. */
export async function serviceFixture(name: string) {
  const f = fixture(name, "run: () => 1");
  await save(f);
  const store = await fixtureStore(f.home);

  const service = makeLocalService({
    store,
    home: f.home,
  });

  return { f, store, service };
}

/** The daemon's start URL carries its bearer token in the fragment, where the dashboard reads it. */
export function daemonToken(url: URL) {
  return new URLSearchParams(url.hash.slice(1)).get("token");
}
