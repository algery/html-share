import { runInNewContext } from "node:vm";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { sendPasswordPage } from "./password-page.js";

type SubmitHandler = (event: { preventDefault(): void }) => Promise<void>;
class Element {
  value = "";
  textContent = "";
  disabled = false;
  focused = false;
  attributes = new Map<string, string>();
  submit: SubmitHandler = async () => undefined;
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  focus() {
    this.focused = true;
  }
  addEventListener(_name: string, listener: SubmitHandler) {
    this.submit = listener;
  }
}

async function render() {
  const app = Fastify({ logger: false });
  app.get("/", (_request, reply) =>
    sendPasswordPage(reply, {
      state: "signed-state",
      returnPath: "/abc12/a%20b.html?preview=1",
    }),
  );
  const page = await app.inject("/");
  await app.close();
  const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("missing password page script");
  const elements = new Map(
    ["password-form", "password", "submit", "status"].map((id) => [id, new Element()]),
  );
  const element = (id: string) => {
    const value = elements.get(id);
    if (!value) throw new Error("unknown DOM element");
    return value;
  };
  const fetch = vi.fn<
    (
      url: string,
      options: { body: string },
    ) => Promise<{
      status: number;
      ok: boolean;
      json(): Promise<unknown>;
      headers: { get(name: string): string | null };
    }>
  >();
  const replace = vi.fn();
  runInNewContext(script, { document: { getElementById: element }, fetch, location: { replace } });
  return {
    input: element("password"),
    button: element("submit"),
    status: element("status"),
    form: element("password-form"),
    submit: () =>
      element("password-form").submit({
        preventDefault() {
          /* Browser default navigation is suppressed. */
        },
      }),
    fetch,
    replace,
  };
}

function response(status: number, body: unknown = {}, retryAfter: string | null = null) {
  return { status, ok: status === 200, json: async () => body, headers: { get: () => retryAfter } };
}

describe("password form interactive states", () => {
  it("focuses and labels the empty-password error without attempting a request", async () => {
    const page = await render();
    page.input.value = " \t ";
    await page.submit();
    expect(page.status.textContent).toBe("请输入访问密码");
    expect(page.input.attributes.get("aria-invalid")).toBe("true");
    expect(page.input.focused).toBe(true);
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it("accepts pasted text, blocks repeat submits during fetch and retains disabled state until navigation", async () => {
    const page = await render();
    let complete: ((result: ReturnType<typeof response>) => void) | undefined;
    page.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    page.input.value = "  Abcd2345  ";
    const pending = page.submit();
    expect(page.button.disabled).toBe(true);
    expect(page.input.disabled).toBe(true);
    expect(page.form.attributes.get("aria-busy")).toBe("true");
    expect(page.status.textContent).toBe("正在验证访问密码…");
    await page.submit();
    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(page.fetch.mock.calls[0]?.[1].body ?? "{}")).toEqual({
      state: "signed-state",
      password: "Abcd2345",
    });
    complete?.(response(200, { redirectUrl: "/abc12/a%20b.html?preview=1" }));
    await pending;
    expect(page.replace).toHaveBeenCalledWith("/abc12/a%20b.html?preview=1");
    expect(page.input.value).toBe("");
    expect(page.button.disabled).toBe(true);
    await page.submit();
    expect(page.fetch).toHaveBeenCalledTimes(1);
  });

  it("restores retry controls after wrong passwords, 429 and network failures", async () => {
    const page = await render();
    page.input.value = "Abcd2345";
    page.fetch.mockResolvedValueOnce(response(401));
    await page.submit();
    expect(page.status.textContent).toBe("密码错误，请重试");
    expect(page.input.attributes.get("aria-invalid")).toBe("true");
    expect(page.button.disabled).toBe(false);
    page.fetch.mockResolvedValueOnce(response(429, {}, "17"));
    await page.submit();
    expect(page.status.textContent).toContain("17 秒后重试");
    expect(page.button.disabled).toBe(false);
    page.fetch.mockRejectedValueOnce(new Error("network offline"));
    await page.submit();
    expect(page.status.textContent).toBe("网络连接失败，请检查网络后重试");
    expect(page.input.disabled).toBe(false);
    expect(page.input.focused).toBe(true);
    expect(page.fetch).toHaveBeenCalledTimes(3);
  });

  it("shows expiry errors and navigates to the uniform 404 when the file is removed", async () => {
    const page = await render();
    page.input.value = "Abcd2345";
    page.fetch.mockResolvedValueOnce(response(400, { error: "页面已过期或无效，请刷新后重试" }));
    await page.submit();
    expect(page.status.textContent).toBe("页面已过期或无效，请刷新后重试");
    page.fetch.mockResolvedValueOnce(response(404));
    await page.submit();
    expect(page.replace).toHaveBeenCalledWith("/abc12/a%20b.html?preview=1");
    expect(page.input.value).toBe("");
  });
});
