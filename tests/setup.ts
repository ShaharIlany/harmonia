// Runs before every test file. The modules under test read the data folder and ~/.claude when they load, so point
// those at a temp folder first: a test run never touches the real data or the real ~/.claude.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harmonia-test-"));
mkdirSync(join(root, "data"));
// Agent files with LF endings: a Windows checkout may have CRLF, which agents.ts can't read (a known bug, not fixed here).
const agents = join(root, "home", ".claude", "agents");
mkdirSync(agents, { recursive: true });
const source = join(import.meta.dir, "..", "agents");
for (const f of readdirSync(source)) writeFileSync(join(agents, f), readFileSync(join(source, f), "utf8").split("\r\n").join("\n"));

process.env.HARMONIA_DATA = join(root, "data");
process.env.HARMONIA_USER = "Alex";
process.env.HARMONIA_STUB = "1";
process.env.USERPROFILE = join(root, "home");
process.env.HOME = join(root, "home");
process.env.CLICKUP_TASK_PREFIX = "ABC";
process.env.CLICKUP_WORKSPACE = "999";
