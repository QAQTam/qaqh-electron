/** 一次性特性探针:headless Edge 对 <textarea> 的 field-sizing: content 支持与实际增高行为。 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_CDP_PORT ?? "9337");
const DATA = mkdtempSync(join(tmpdir(), "qaqh-fs-"));
const html = "data:text/html," + encodeURIComponent(`<!doctype html><textarea id=t rows=2 style="field-sizing:content;min-height:52px;max-height:160px;line-height:22px;width:300px"></textarea><div id=r></div><script>
const t=document.getElementById('t');
const h1=t.getBoundingClientRect().height;
t.value='x'.repeat(2000); t.dispatchEvent(new Event('input'));
requestAnimationFrame(()=>{ const h2=t.getBoundingClientRect().height;
  document.getElementById('r').textContent=JSON.stringify({supports:CSS.supports('field-sizing','content'),h1,h2}); });
<\/script>`);

const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${DATA}`,
  "--disable-gpu", "--no-first-run", "--no-default-browser-check", html], { stdio: "ignore" });

const deadline = Date.now() + 20_000;
let text = "";
while (Date.now() < deadline) {
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    const page = list.find((p) => p.type === "page");
    if (page?.webSocketDebuggerUrl) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res) => ws.addEventListener("open", res, { once: true }));
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      await new Promise((res) => setTimeout(res, 600));
      const out = await new Promise((res) => {
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id === 2) res(m.result?.value ?? "");
        });
        ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "document.getElementById('r').textContent", returnByValue: true } }));
      });
      text = out || "empty";
      ws.close();
      if (text !== "empty" && text.length > 3) break;
    }
  } catch { /* up */ }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(text);
child.kill();
rmSync(DATA, { recursive: true, force: true });
