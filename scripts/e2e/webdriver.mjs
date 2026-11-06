// Minimal W3C WebDriver client for tauri-driver (no dependencies, Node 20+).
// tauri-driver forwards to WebKitWebDriver, which drives the real Crabshell window (WebKitGTK).

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export class Session {
  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  static async start(application, base = "http://127.0.0.1:4444") {
    const response = await request(base, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    });
    return new Session(base, response.sessionId);
  }

  cmd(method, path, body) {
    return request(this.base, method, `/session/${this.id}${path}`, body);
  }

  async end() {
    await this.cmd("DELETE", "").catch(() => undefined);
  }

  /** Waits until `selector` matches and returns the element id. */
  async find(selector, timeout = 10000) {
    const until = Date.now() + timeout;
    for (;;) {
      try {
        const element = await this.cmd("POST", "/element", { using: "css selector", value: selector });
        return element[ELEMENT];
      } catch (error) {
        if (Date.now() > until) throw new Error(`Not found: ${selector} (${error.message})`);
        await sleep(150);
      }
    }
  }

  async click(selector) {
    const id = await this.find(selector);
    await this.cmd("POST", `/element/${id}/click`, {});
  }

  /** Runs `script` (a function body) in the page and returns its result. */
  run(script, ...args) {
    return this.cmd("POST", "/execute/sync", { script, args });
  }

  /** Mouse actions on the element's center: "double", "right" or a plain click. */
  async mouse(selector, kind = "click") {
    const id = await this.find(selector);
    const origin = { [ELEMENT]: id };
    const button = kind === "right" ? 2 : 0;
    const press = [{ type: "pointerDown", button }, { type: "pointerUp", button }];
    await this.cmd("POST", "/actions", {
      actions: [{
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", origin, x: 0, y: 0 }, ...press, ...(kind === "double" ? press : [])],
      }],
    });
    await this.cmd("DELETE", "/actions").catch(() => undefined);
  }

  /** Types text into whatever has the focus. "" is Enter, "" Escape. */
  async keys(text) {
    const actions = [...text].flatMap((value) => [{ type: "keyDown", value }, { type: "keyUp", value }]);
    await this.cmd("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions }] });
    await this.cmd("DELETE", "/actions").catch(() => undefined);
  }
}

export const KEY = { enter: "", escape: "" };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.value?.error) {
    throw new Error(`${method} ${path}: ${data.value?.error ?? response.status} ${data.value?.message ?? ""}`.trim());
  }
  return data.value;
}
