// 화면을 실제로 렌더해 보고 클라이언트 오류를 듣는다.
//
//   node scripts/render_check.js http://localhost:3000/project?rfq=1&stage=9 [url ...]
//
// 왜 있는가: `npm run build` 는 컴포넌트를 실행하지 않는다. 훅을 조기 return 뒤에
// 두는 실수는 타입도 빌드도 통과하고, 그 화면을 열어야 "This page couldn't load" 로
// 터진다(완료된 딜을 못 여는 사고가 그것이었다). 여기서는 헤드리스 Chrome 을 CDP 로
// 붙여 콘솔 오류와 예외를 직접 듣고, 모달이 실제로 떴는지까지 본다.
//
// 준비: 백엔드와 next dev 를 로컬에 띄우고(아래), ws 모듈이 있어야 한다(npx 로 충분).
//   ktms:  DATABASE_URL=sqlite:///<사본> ADMIN_API_TOKEN=dev-token python -m uvicorn admin_api:app --port 8002
//   web :  NEXT_PUBLIC_API_BASE=http://127.0.0.1:8002 npm run dev
// 로그인 대신 정적 ADMIN_API_TOKEN 을 localStorage 에 심는다 — 운영 주소에 쓰지 말 것.
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// 크롬 경로 — 다른 곳에 깔려 있으면 CHROME_PATH 로 덮어쓴다.
const CHROME = process.env.CHROME_PATH
  || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9222;
const TOKEN = "dev-token";

const get = (path) =>
  new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(JSON.parse(b)));
    }).on("error", rej);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const urls = process.argv.slice(2);
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    // 확장 프로그램의 배경 페이지가 디버깅 대상 목록에 섞여 들어와 엉뚱한 곳을 재게 된다.
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), "ktms-render-check")}`,
    "about:blank",
  ], { stdio: "ignore" });

  let tabs;
  for (let i = 0; i < 40; i++) {
    try {
      const all = await get("/json/list");
      tabs = all.filter((t) => t.type === "page" && !t.url.startsWith("chrome-extension://"));
      if (tabs.length) break;
    } catch {}
    await sleep(250);
  }
  const WebSocket = require("ws");
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on("open", r));

  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      problems.push("console.error: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400));
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      problems.push("exception: " + (d.exception?.description ?? d.text ?? "").slice(0, 400));
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Runtime.enable");
  await send("Page.enable");

  // 로그인 대신 토큰을 심는다 — 정적 ADMIN_API_TOKEN 은 admin 으로 통한다.
  await send("Page.navigate", { url: "http://localhost:3000/login" });
  await sleep(2500);
  await send("Runtime.evaluate", {
    expression: `localStorage.setItem('ktms_token', ${JSON.stringify(TOKEN)});
      localStorage.setItem('ktms_user', JSON.stringify({id:0,username:'dev',role:'admin'}));
      localStorage.removeItem('ktms_perms'); localStorage.removeItem('ktms_scope');`,
  });

  let bad = 0;
  for (const url of urls) {
    problems.length = 0;
    await send("Page.navigate", { url });
    await sleep(9000);
    const title = await send("Runtime.evaluate", {
      expression: `(() => {
        const m = document.querySelector('.pl-modal');
        const tabs = [...document.querySelectorAll('.pane-tabs button')].map(b=>b.textContent.trim()).join(' / ');
        return 'modal=' + (m ? 'yes' : 'NO') + ' | tabs=[' + tabs + '] | ' +
               (m ? m.innerText.replace(/\s+/g,' ').slice(0,260) : document.body.innerText.slice(0,160));
      })()`, returnByValue: true,
    });
    const text = title.result?.value ?? "";
    const crashed = /couldn.t load|Application error|Unhandled Runtime/i.test(text)
      || problems.some((p) => /Rendered more hooks|Minified React error|exception:/i.test(p));
    if (crashed) {
      bad++;
      console.log(`[FAIL] ${url}`);
      console.log("       body: " + text.replace(/\n/g, " | ").slice(0, 160));
      problems.slice(0, 3).forEach((p) => console.log("       " + p.replace(/\n/g, " ").slice(0, 200)));
    } else {
      console.log(`[OK  ] ${url}  — ${text.replace(/\n/g, " | ").slice(0, 90)}`);
    }
  }
  ws.close();
  chrome.kill();
  console.log(`\n${urls.length - bad}/${urls.length} rendered`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
