// A local server that fails twice, then works. Run:  node examples/flaky-server.ts
import { createServer } from "node:http";

import { createGuard } from "../src/index.ts";

let hits = 0;
const server = createServer((_req, res) => {
  hits += 1;
  if (hits <= 2) {
    res.writeHead(503, { "retry-after": "0" });
    res.end("busy");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ price: 42, hits }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };

const guard = createGuard({
  baseDelayMs: 50,
  onEvent: (e) => console.log("event:", JSON.stringify(e)),
});

console.log(await guard.json(`http://127.0.0.1:${port}/price?api_key=SECRET`));
console.log("breakers:", guard.breakers());
server.close();
