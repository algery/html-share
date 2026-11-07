import { CopyCodeButton } from "../../components/copy-code-button";

interface InstallGuideProps {
  apiUrl: string;
  host: "claude" | "codex";
  mcpUrl: string;
}

function Command({ value }: { value: string }) {
  return (
    <div className="mt-2">
      <pre className="max-w-full overflow-x-auto rounded-lg bg-slate-900 p-4 font-mono text-xs leading-6 text-slate-100">
        {value}
      </pre>
      <CopyCodeButton value={value} />
    </div>
  );
}

function ManualMcpGuide({ mcpUrl }: Pick<InstallGuideProps, "mcpUrl">) {
  const fields = [
    ["服务名称", "html-share"],
    ["传输方式", "Streamable HTTP（有些界面写作 HTTP）"],
    ["MCP 地址", mcpUrl],
    ["鉴权请求头", "Authorization"],
    ["请求头值", "Bearer <刚创建的 Token>"],
  ];

  return (
    <section
      aria-labelledby="manual-mcp-heading"
      className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/60 p-4"
    >
      <h3 className="section-title" id="manual-mcp-heading">
        1. 手动添加 MCP
      </h3>
      <p>先在本页创建 Token，再到你的工具里添加一个远程 MCP 服务，按下面填写。</p>
      <dl className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {fields.map(([label, value]) => (
          <div className="grid gap-1 px-3 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]" key={label}>
            <dt className="font-medium text-slate-900">{label}</dt>
            <dd className="min-w-0 wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-5 text-slate-600">
        如果界面有单独的 Bearer Token 输入框，只填 Token 本身。使用请求头时，保留 Bearer
        和后面的空格， 将占位文字（含尖括号）替换为你的 Token。Token
        只填写在本机连接设置或环境变量中。
      </p>
    </section>
  );
}

function AgentInstallGuide({ apiUrl, host, mcpUrl }: InstallGuideProps) {
  const isCodex = host === "codex";
  const hostName = isCodex ? "Codex" : "Claude Code";
  const archive = isCodex ? "codex-html-share.zip" : "claude-code-html-share.zip";
  const skillPath = isCodex ? "~/.codex/skills/html-share" : "~/.claude/skills/html-share";
  const serverConfig = isCodex
    ? `使用 ~/.codex/config.toml 的 [mcp_servers.html-share]，设置 url = ${JSON.stringify(mcpUrl)}，bearer_token_env_var = "HTML_SHARE_MCP_TOKEN"。`
    : `在当前项目的 .mcp.json 中合并 mcpServers.html-share，设置 type 为 http，url 为 ${mcpUrl}，headers.Authorization 为 Bearer \${HTML_SHARE_MCP_TOKEN}。`;
  const prompt = [
    `请帮我在 ${hostName} 中安装 Demo Share Skill，并检查 MCP 连接。`,
    `1. 只使用我提供的本地 ${archive}。如果没有收到文件或无法读取附件，先请我提供本地 ZIP 路径。不要自行下载 Skill。`,
    `2. 检查压缩包内容，将 Skill 安装到 ${skillPath}，确认该目录下有 SKILL.md。如果已有同名 Skill，先征得我同意再覆盖。`,
    `3. 检查是否已配置 html-share。已有配置时保留原条目，地址不一致请先问我；未配置时，${serverConfig} 保留其他配置项。`,
    "4. 如果还未配置 Token，提醒我在本机设置 HTML_SHARE_MCP_TOKEN 或在工具界面手动填写。不要让我把 Token 发到聊天中，也不要读取并回显完整值。如果当前会话已能调用 Demo Share 的连接检查，请执行并报告结果。最后告诉我 Skill 和 MCP 的配置状态，以及是否需要重启工具。",
  ].join("\n\n");

  return (
    <section aria-labelledby="agent-install-heading">
      <h3 className="section-title" id="agent-install-heading">
        2. 让 Agent 安装 Skill
      </h3>
      <ol className="mt-2 list-decimal space-y-2 pl-5">
        <li>
          <a
            className="font-semibold text-blue-700 underline underline-offset-4"
            download
            href={`${apiUrl}/api/skills/${isCodex ? "codex" : "claude-code"}`}
          >
            下载 {hostName} 安装包
          </a>
          ，保存 ZIP 文件。
        </li>
        <li>把 ZIP 文件交给 Agent，再把下面的提示词发给它。</li>
      </ol>
      <CopyCodeButton label="复制 Agent 安装提示词" tone="primary" value={prompt} />
      <pre className="mt-3 whitespace-pre-wrap wrap-anywhere rounded-lg border border-slate-200 bg-slate-50 p-4 font-sans text-sm leading-6">
        {prompt}
      </pre>
    </section>
  );
}

function AdvancedSetup({ host, mcpUrl }: Pick<InstallGuideProps, "host" | "mcpUrl">) {
  const isCodex = host === "codex";
  const tokenCommand = "export HTML_SHARE_MCP_TOKEN='<刚创建的 Token>'";
  const codexConfig = `[mcp_servers.html-share]\nurl = ${JSON.stringify(mcpUrl)}\nbearer_token_env_var = "HTML_SHARE_MCP_TOKEN"`;
  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        "html-share": {
          headers: { Authorization: "Bearer ${HTML_SHARE_MCP_TOKEN}" },
          type: "http",
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );

  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 sm:px-4">
      <summary className="min-h-10 cursor-pointer py-2 font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-700">
        高级配置（命令行和配置文件）
      </summary>
      <div className="space-y-4 pb-4">
        <div>
          <h4 className="font-semibold">手动解压 Skill</h4>
          <Command value={`unzip -o ${isCodex ? "codex" : "claude-code"}-html-share.zip -d ~`} />
        </div>
        <div>
          <h4 className="font-semibold">连接 {isCodex ? "Codex" : "Claude Code"} MCP</h4>
          <p className="mt-1">
            在本机终端设置 <code>HTML_SHARE_MCP_TOKEN</code>，再从该环境启动工具。
            需要编辑配置时，将下方条目合并到{" "}
            <code>{isCodex ? "~/.codex/config.toml" : "项目 .mcp.json"}</code>。
          </p>
          <Command value={isCodex ? codexConfig : claudeConfig} />
          <Command
            value={
              isCodex
                ? `${tokenCommand}\ncodex mcp add html-share --url '${mcpUrl}' --bearer-token-env-var HTML_SHARE_MCP_TOKEN\ncodex mcp list`
                : `${tokenCommand}\nclaude mcp list`
            }
          />
        </div>
      </div>
    </details>
  );
}

export function InstallGuide({ apiUrl, host, mcpUrl }: InstallGuideProps) {
  return (
    <div className="mt-4 grid min-w-0 grid-cols-1 gap-5 text-sm leading-6 text-slate-700">
      <ManualMcpGuide mcpUrl={mcpUrl} />
      <AgentInstallGuide apiUrl={apiUrl} host={host} mcpUrl={mcpUrl} />
      <AdvancedSetup host={host} mcpUrl={mcpUrl} />
      <section>
        <h3 className="font-semibold text-slate-900">指定链接访问方式</h3>
        <p className="mt-1">默认仅组织成员可访问。需要密码访问时，发布时明确告诉 Agent：</p>
        <Command value="发布这个 Demo，开启密码访问，并返回链接和访问密码。" />
        <p className="mt-2">
          覆盖更新会沿用原模式和密码。需要变更时明确说“关闭密码访问”或“重新生成访问密码”。
          密码由服务端生成，未登录的查看者可输入密码，或选择钉钉登录打开。
        </p>
      </section>
    </div>
  );
}
