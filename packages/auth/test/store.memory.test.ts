import { createMemoryStore } from "../src/store";
import { runAuthStoreSuite } from "./store.suite";

runAuthStoreSuite("memory", () => createMemoryStore());
