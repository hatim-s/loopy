import { MemoryRunStore } from "../src/runtime/index.js";
import { storeContract } from "./store-contract.js";

storeContract("MemoryRunStore", () => new MemoryRunStore());
