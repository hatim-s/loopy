import type { Store } from "../core/index.js";
import { MemoryQueryFeeds } from "./memory-query-feeds.js";

export class MemoryStore extends MemoryQueryFeeds implements Store {}
