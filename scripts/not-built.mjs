// Root commands from CLAUDE.md that do not exist yet. They fail on purpose so nothing mistakes a stub for a working step.
const [name, task] = process.argv.slice(2);
console.error(`pnpm ${name} is not built yet (task ${task}).`);
process.exit(1);
