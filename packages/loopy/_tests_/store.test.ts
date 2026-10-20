import { afterEach } from "bun:test";
import { SqliteRunStore } from "../src/store/index.js";
import { storeContract } from "./store-contract.js";

const stores: SqliteRunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

storeContract("sqlite", (options) => {
  const store = new SqliteRunStore(":memory:", options?.now, options);
  stores.push(store);

  return store;
});
