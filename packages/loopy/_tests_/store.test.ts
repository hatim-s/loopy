import { afterEach } from "bun:test";
import { storeContract } from "./store-contract";
import { createTestStores, memoryStore } from "./store-fixture";

const { openTestStore, closeTestStores } = createTestStores();

afterEach(closeTestStores);

storeContract("local sqlite", (options) => openTestStore(":memory:", options));

storeContract("portable sqlite", (options) => memoryStore(options));
