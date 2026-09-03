import { CopyCodeButton } from "../../components/copy-code-button";

interface InstallGuideProps {
  apiUrl: string;
  host: "claude" | "codex";
  mcpUrl: string;
}

function Command({ value }: { value: string }) {
  return (
    <div className="mt-2">
      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
        {value}
      </pre>
      <CopyCodeButton value={value} />
    </div>
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
    <div className="mt-4 grid gap-5 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">
      <p>先创建 Token；它只应保存在本机环境变量或宿主配置，不要放入项目、聊天或截图。</p>
      <section>
        <h3 className="font-semibold text-slate-900">1. 下载并安装 Skill</h3>
        <a
          className="mt-2 inline-flex font-semibold text-blue-700 hover:text-blue-800"
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
          <h3 className="font-semibold text-slate-900">3. 连接 Claude Code MCP</h3>
          <p className="mt-1">
            将下列内容放入项目 <code>.mcp.json</code>，并在启动 Claude Code 前设置{" "}
            <code>HTML_SHARE_MCP_TOKEN</code>。配置使用环境变量展开，不把 Token 写入文件。
          </p>
          <Command value={claudeConfig} />
          <Command value="export HTML_SHARE_MCP_TOKEN='<刚创建的 Token>'\nclaude mcp list" />
        </section>
      )}
      <p className="text-xs leading-5 text-slate-500">
        连接后运行 <code>codex mcp list</code> 或 <code>claude mcp list</code>
        ，再让宿主执行“分享这个 Demo”。
      </p>
    </div>
  );
}
