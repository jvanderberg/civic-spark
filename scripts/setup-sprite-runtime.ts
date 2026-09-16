import { AgentSessions } from "../apps/server/src/agents.ts";

const flag = process.argv.indexOf("--sprite");
const sprite = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!sprite || !/^civic-spark-[a-z0-9-]{1,45}$/.test(sprite)) {
  throw new Error("Usage: npm run setup:sprite -- --sprite civic-spark-NAME");
}
if (!(await new AgentSessions().prepare(sprite))) {
  throw new Error(
    "Runtime setup failed. Check Sprite connectivity, then rerun setup. No ready marker was written for a failed install.",
  );
}
console.log(`Runtime verified in ${sprite}: OpenCode 1.18.31; Claude Code 2.1.273`);
