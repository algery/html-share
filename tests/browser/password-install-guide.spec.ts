import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.HTML_SHARE_INSTALL_WEB_URL ?? "http://127.0.0.1:53000";
const publishCommand = "发布这个 Demo，开启密码访问，并返回链接和访问密码。";

// Every API response and clipboard write is synthetic. No real Token is created or captured.
test.use({ trace: "off", video: "off" });

async function openGuide(page: Page, clipboardFails = false) {
  const unexpectedRequests: string[] = [];
  await page.route("**/auth/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/auth/current") {
      await route.fulfill({
        json: { user: { displayName: "安装验收用户" }, csrfToken: "ui-test-only" },
      });
    } else {
      unexpectedRequests.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 404, json: { error: "test_request_not_allowed" } });
    }
  });
  await page.route("**/api/**", async (route) => {
    if (
      new URL(route.request().url()).pathname === "/api/tokens" &&
      route.request().method() === "GET"
    ) {
      await route.fulfill({ json: { tokens: [] } });
    } else {
      unexpectedRequests.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 404, json: { error: "test_request_not_allowed" } });
    }
  });
  await page.addInitScript((fails) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (fails) throw new Error("test clipboard unavailable");
          document.documentElement.dataset["copied"] = value;
        },
      },
    });
  }, clipboardFails);
  await page.goto(`${webUrl}/tokens`);
  await expect(page.getByRole("heading", { name: "我的 Token", exact: true })).toBeVisible();
  const account = page.getByRole("group", { name: "账号操作" });
  await expect(account.getByText("安装验收用户")).toBeVisible();
  await expect(account.getByRole("link", { name: "我的 Token" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(account.getByRole("button", { name: "退出" })).toBeVisible();
  await page.getByRole("button", { name: "手动添加 MCP / 安装 Skill" }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  return unexpectedRequests;
}

for (const width of [1280, 375]) {
  test(`${width}px 双宿主安装指引与密码发布示例沿用卡片、可复制且无页面横溢`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const unexpectedRequests = await openGuide(page);
    for (const host of ["Codex", "Claude Code"] as const) {
      const tab = page.getByRole("tab", { name: host, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const panel = page.getByRole("tabpanel");
      const install = panel
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "2. 让 Agent 安装 Skill" }) });
      const access = panel
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "指定链接访问方式" }) });
      await expect(install.getByRole("link", { name: `下载 ${host} 安装包` })).toHaveAttribute(
        "href",
        new RegExp(`/api/skills/${host === "Codex" ? "codex" : "claude-code"}$`),
      );
      const advanced = panel.locator("details").filter({ hasText: "高级配置（命令行和配置文件）" });
      await expect(advanced).not.toHaveAttribute("open", "");
      await advanced.locator("summary").click();
      const unzip = advanced.locator("pre").filter({ hasText: "unzip -o" });
      await expect(unzip).toHaveText(
        `unzip -o ${host === "Codex" ? "codex" : "claude-code"}-html-share.zip -d ~`,
      );
      await expect(panel).toContainText("HTML_SHARE_MCP_TOKEN");
      await expect(panel).toContainText(host === "Codex" ? "codex mcp list" : "claude mcp list");
      const mcpAddress = panel
        .getByRole("region", { name: "1. 手动添加 MCP" })
        .locator("dd")
        .nth(2);
      const mcpUrl = (await mcpAddress.textContent()) ?? "";
      const config = advanced.locator("pre").filter({
        hasText: host === "Codex" ? "[mcp_servers.html-share]" : '"mcpServers"',
      });
      const configText = (await config.textContent()) ?? "";
      if (host === "Codex") {
        expect(configText).toBe(
          `[mcp_servers.html-share]\nurl = "${mcpUrl}"\nbearer_token_env_var = "HTML_SHARE_MCP_TOKEN"`,
        );
      } else {
        expect(JSON.parse(configText)).toEqual({
          mcpServers: {
            "html-share": {
              type: "http",
              url: mcpUrl,
              headers: { Authorization: "Bearer ${HTML_SHARE_MCP_TOKEN}" },
            },
          },
        });
      }
      await config.locator("xpath=..").getByRole("button", { name: "复制配置" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-copied", configText);
      if (host === "Claude Code") {
        await expect(panel.getByRole("heading", { name: "连接 Claude Code MCP" })).toBeVisible();
        const shellText = "export HTML_SHARE_MCP_TOKEN='<刚创建的 Token>'\nclaude mcp list";
        const shell = panel.locator("pre").filter({ hasText: "export HTML_SHARE_MCP_TOKEN" });
        expect(await shell.textContent()).toBe(shellText);
        await shell.locator("xpath=..").getByRole("button", { name: "复制配置" }).click();
        await expect(page.locator("html")).toHaveAttribute("data-copied", shellText);
      }
      await expect(access).toContainText("默认仅组织成员可访问");
      await expect(access).toContainText("发布时明确告诉 Agent");
      await expect(access).toContainText("覆盖更新会沿用原模式和密码");
      await expect(access).toContainText("关闭密码访问");
      await expect(access).toContainText("重新生成访问密码");
      await expect(access).toContainText("密码由服务端生成");
      await expect(access).toContainText("未登录的查看者可输入密码，或选择钉钉登录打开");
      await expect(access.locator("pre")).toHaveText(publishCommand);
      await access.getByRole("button", { name: "复制配置" }).click();
      await expect(access).toContainText("已复制");
      await expect(page.locator("html")).toHaveAttribute("data-copied", publishCommand);

      const cardStyle = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          borderRadius: style.borderRadius,
          fontSize: style.fontSize,
          padding: style.padding,
        };
      };
      expect(await access.locator("pre").evaluate(cardStyle)).toEqual(
        await unzip.evaluate(cardStyle),
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const filename = `install-${host === "Codex" ? "codex" : "claude"}-${width}`;
      await panel.screenshot({ path: test.info().outputPath(`${filename}-guide.png`) });
      await page.screenshot({
        path: test.info().outputPath(`${filename}-page.png`),
        fullPage: true,
      });
      await advanced.locator("summary").click();
    }
    expect(unexpectedRequests).toEqual([]);
    await expect(page.getByRole("heading", { name: "请立即复制 Token" })).toHaveCount(0);
  });
}

test("发布命令复制失败时保留可手动复制的完整文本", async ({ page }) => {
  const unexpectedRequests = await openGuide(page, true);
  const access = page
    .getByRole("tabpanel")
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "指定链接访问方式" }) });
  await access.getByRole("button", { name: "复制配置" }).click();
  await expect(access).toContainText("复制失败，请手动复制");
  await expect(access.locator("pre")).toHaveText(publishCommand);
  expect(unexpectedRequests).toEqual([]);
});

test("两端优先显示手动参数，并能复制只使用本地 ZIP 的安装提示词", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const unexpectedRequests = await openGuide(page);
  const panel = page.getByRole("tabpanel");

  for (const host of ["Codex", "Claude Code"] as const) {
    await page.getByRole("tab", { name: host, exact: true }).click();
    const install = panel.getByRole("region", { name: "2. 让 Agent 安装 Skill" });
    const download = await install
      .getByRole("link", { name: `下载 ${host} 安装包` })
      .getAttribute("href");
    if (!download) throw new Error("安装包缺少服务地址");
    const mcpUrl = new URL("/mcp", new URL(download, webUrl)).href;
    const manual = panel.getByRole("region", { name: "1. 手动添加 MCP" });
    await expect(manual.getByText(mcpUrl, { exact: true })).toBeVisible();
    await expect(manual.getByText("html-share", { exact: true })).toBeVisible();
    await expect(manual.getByText("Streamable HTTP", { exact: false })).toBeVisible();
    await expect(manual.getByText("Authorization", { exact: true })).toBeVisible();
    await expect(manual.getByText("Bearer <刚创建的 Token>", { exact: true })).toBeVisible();
    expect((await manual.boundingBox())?.y).toBeLessThan((await install.boundingBox())?.y ?? 0);

    const prompt = install.locator("pre");
    await expect(prompt).toContainText(
      host === "Codex" ? "codex-html-share.zip" : "claude-code-html-share.zip",
    );
    await expect(prompt).toContainText(
      host === "Codex" ? "~/.codex/skills/html-share" : "~/.claude/skills/html-share",
    );
    await expect(prompt).toContainText(mcpUrl);
    await expect(prompt).toContainText("不要自行下载 Skill");
    await expect(prompt).toContainText("请我提供本地 ZIP 路径");
    await expect(prompt).toContainText("不要让我把 Token 发到聊天中");
    await expect(prompt).not.toContainText("/api/skills/");
    await install.getByRole("button", { name: "复制 Agent 安装提示词" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-copied",
      (await prompt.textContent()) ?? "",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }

  expect(unexpectedRequests).toEqual([]);
});
