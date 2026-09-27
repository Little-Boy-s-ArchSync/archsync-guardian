import { analyzeModuleProject, moduleArchitecture } from "../dist/module-graph.js";

const [config, root, ...extra] = process.argv.slice(2);
if (!config || extra.length) {
  console.error("Usage: node scripts/module-preflight.mjs <tsconfig.json> [repository-root]");
  process.exitCode = 2;
} else {
  try {
    const graph = analyzeModuleProject(config, root);
    console.log(JSON.stringify({
      purpose: "development-preflight-not-independent-evaluation",
      graph,
      architecture: graph.status === "complete-within-scope" ? moduleArchitecture(graph) : null,
    }, null, 2));
    process.exitCode = graph.status === "complete-within-scope" ? 0 : 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
