const stats = { grants: 0, translations: 0, connections: 0, active: 0, audioBytes: 0, urls: [] };
let failNext = false;
let delayNext = 0;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "test.invalid") {
      if (url.pathname === "/fail-next") failNext = true;
      if (url.pathname === "/delay-next") delayNext = 150;
      return Response.json(stats);
    }
    if (url.hostname === "api.deepseek.com" && url.pathname === "/chat/completions") {
      stats.translations++;
      return Response.json({ choices: [{ message: { content: "离线测试译文" } }] });
    }
    if (url.hostname === "api.deepgram.com" && url.pathname === "/v1/auth/grant") {
      stats.grants++;
      return Response.json({ access_token: "must-never-be-issued" });
    }
    if (url.hostname === "api.deepgram.com" && url.pathname === "/v1/listen") {
      stats.connections++;
      stats.urls.push(url.toString());
      if (delayNext) { const ms = delayNext; delayNext = 0; await new Promise(resolve => setTimeout(resolve, ms)); }
      if (failNext) { failNext = false; return new Response("Simulated provider failure", { status: 502 }); }
      const [client, server] = Object.values(new WebSocketPair());
      server.binaryType = "arraybuffer";
      server.accept();stats.active++;
      server.addEventListener("message", event => {
        if (typeof event.data === "string") {
          const control = JSON.parse(event.data);
          server.send(JSON.stringify({ control: control.type }));
        } else {
          stats.audioBytes += event.data.byteLength;
          server.send(JSON.stringify({ audioBytes: event.data.byteLength }));
        }
      });
      server.addEventListener("close", () => { stats.active--; });
      return new Response(null, { status: 101, webSocket: client });
    }
    throw new Error("Test attempted an unexpected external request: " + request.url);
  },
};
