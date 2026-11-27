// Entry point of the compiled server (Harmonia.app). The same binary also runs the chat sessions' job tools.
// An empty export makes this a module, so top-level await type-checks.
export {};
if (process.argv.includes("--job-tools")) await import("./job-tools");
else await import("./server");
