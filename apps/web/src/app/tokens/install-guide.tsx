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

function ManualMcpGuide({ host, mcpUrl }: Pick<InstallGuideProps, "host" | "mcpUrl">) {
  const isCodex = host === "codex";
  const fields = [
    ["服务名称", "html-share"],
    ["传输方式", isCodex ? "Streamable HTTP" : 'Streamable HTTP（type 填 "http"）'],
    ["MCP 地址", mcpUrl],
    ["鉴权请求头", "Authorization"],
    ["请求头值", "Bearer <刚创建的 Token>"],
  ];
  const codexConfig = `[mcp_servers.html-share]\nurl = ${JSON.stringify(mcpUrl)}\nbearer_token_env_var = "HTML_SHARE_MCP_TOKEN"`;

  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 sm:px-4">
      <summary className="min-h-10 cursor-pointer py-2 font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-700">
        手动添加 MCP
      </summary>
      <div className="space-y-3 pb-4">
        <dl className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {fields.map(([label, value]) => (
            <div className="grid gap-1 px-3 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]" key={label}>
              <dt className="font-medium text-slate-900">{label}</dt>
              <dd className="min-w-0 break-all font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
        <p>
          启动宿主前，将刚创建的 Token 设置为本机环境变量 <code>HTML_SHARE_MCP_TOKEN</code>
          。配置文件中只引用变量。
        </p>
        {isCodex ? (
          <>
            <p>
              在 <code>~/.codex/config.toml</code> 中添加以下配置。如果已有{" "}
              <code>[mcp_servers.html-share]</code>，更新原有条目。
            </p>
            <Command value={codexConfig} />
          </>
        ) : (
          <p>
            将上方 <code>.mcp.json</code> 示例中的 <code>html-share</code> 合并到项目的{" "}
            <code>mcpServers</code>。<code>headers.Authorization</code> 填{" "}
            <code className="break-all">{"Bearer ${HTML_SHARE_MCP_TOKEN}"}</code>。
          </p>
        )}
      </div>
    </details>
  );
}

export function InstallGuide({ apiUrl, host, mcpUrl }: InstallGuideProps) {
  const codexCommand = `export HTML_SHARE_MCP_TOKEN='<刚创建的 Token>'\ncodex mcp add html-share --url '${mcpUrl}' --bearer-token-env-var HTML_SHARE_MCP_TOKEN\ncodex mcp list`;
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

  const isCodex = host === "codex";
  const skillCommand = isCodex
    ? "unzip -o codex-html-share.zip -d ~"
    : "unzip -o claude-code-html-share.zip -d ~";
  return (
    <div className="mt-4 grid min-w-0 grid-cols-1 gap-5 text-sm leading-6 text-slate-700">
      <p>先创建 Token；它只应保存在本机环境变量或宿主配置，不要放入项目、聊天或截图。</p>
      <section>
        <h3 className="font-semibold text-slate-900">1. 下载并安装 Skill</h3>
        <a
          className="button-secondary mt-2 inline-flex"
          download
          href={`${apiUrl}/api/skills/${isCodex ? "codex" : "claude-code"}`}
        >
          下载 {isCodex ? "Codex" : "Claude Code"} 安装包
        </a>
        <Command value={skillCommand} />
      </section>
      {isCodex ? (
        <section>
          <h3 className="font-semibold text-slate-900">2. 连接 Codex MCP</h3>
          <Command value={codexCommand} />
        </section>
      ) : (
        <section>
          <h3 className="font-semibold text-slate-900">2. 连接 Claude Code MCP</h3>
          <p className="mt-1">
            将下列内容放入项目 <code>.mcp.json</code>，并在启动 Claude Code 前设置{" "}
            <code>HTML_SHARE_MCP_TOKEN</code>。配置使用环境变量展开，不把 Token 写入文件。
          </p>
          <Command value={claudeConfig} />
          <Command value={"export HTML_SHARE_MCP_TOKEN='<刚创建的 Token>'\nclaude mcp list"} />
        </section>
      )}
      <ManualMcpGuide host={host} mcpUrl={mcpUrl} />
      <section>
        <h3 className="font-semibold text-slate-900">指定链接访问方式</h3>
        <p className="mt-1">默认仅组织成员可访问。需要密码访问时，发布时明确告诉 Agent：</p>
        <Command value="发布这个 Demo，开启密码访问，并返回链接和访问密码。" />
        <p className="mt-2">
          覆盖更新会沿用原模式和密码。需要变更时明确说“关闭密码访问”或“重新生成访问密码”。
          密码由服务端生成，未登录的查看者可输入密码，或选择钉钉登录打开。
        </p>
      </section>
      <p className="text-xs leading-5 text-slate-500">
        连接后运行 <code>codex mcp list</code> 或 <code>claude mcp list</code>
        ，再让宿主执行“分享这个 Demo”。
      </p>
    </div>
  );
}
