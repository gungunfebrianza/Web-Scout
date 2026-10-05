// The surface map: every way to reach a Web-Scout feature (CLI, MCP, HTTP, dashboard) and how they connect.
// Built from the files that already define them, so it cannot drift: cli-spec.mjs (commands and their MCP twins),
// surfaces.mjs (capabilities), the relay's route modules and dashboard.html (what the dashboard really calls).
//   node vendor/surfacemap/bin/surfacemap.mjs build     writes docs/surfacemap.html and .json
//   node vendor/surfacemap/bin/surfacemap.mjs check     what surfacemap.test.mjs runs
import { defineConfig } from './vendor/surfacemap/src/config.mjs';
import { routes, clientCalls, capabilities, commands, extractors } from './vendor/surfacemap/src/adapters/index.mjs';
import { SURFACES, INTERNAL_ROUTES } from './surfaces.mjs';
import { CLI_SPEC } from './cli-spec.mjs';

export default defineConfig({
  project: 'Web-Scout',
  purpose: 'Every way to reach a Web-Scout feature - CLI, MCP, HTTP and the dashboard - and how they are wired. Pick a command, route or capability to see what it connects to. A colored edge marks drift: something declared that the code does not have, or the reverse.',
  out: 'docs/surfacemap',
  adapters: [
    routes({ files: ['relay.mjs', 'routes-*.mjs'], extract: extractors.methodPattern, internal: INTERNAL_ROUTES }),
    clientCalls({ files: ['dashboard.html'], extract: (source) => [...extractors.apiCalls(source), ...extractors.fetchCalls(source)] }),
    commands({ rows: CLI_SPEC }),
    capabilities({ rows: SURFACES }),
  ],
});
