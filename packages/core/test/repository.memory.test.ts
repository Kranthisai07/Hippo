import { createMemoryRepository } from "../src/repository/memory";
import { runRepositorySuite } from "./repository.suite";

runRepositorySuite("memory", () => createMemoryRepository());
