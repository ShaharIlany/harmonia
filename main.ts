// Entry point of the compiled server (Team Chat.app). The same binary also runs the chat sessions' job tools.
if (process.argv.includes("--job-tools")) await import("./job-tools");
else await import("./server");
