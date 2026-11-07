import { useEffect, type ComponentProps } from "react";

import type { DemoSummary } from "./demo-list";
import { PasswordAccessManager, type ProjectAccessState } from "./password-access-manager";
import { ProjectHomepageManager } from "./project-homepage-manager";
import { ProjectSquareManager } from "./project-square-manager";

interface DemoDetailSettingsProps {
  apiUrl: string;
  csrfToken: string | null;
  files: ComponentProps<typeof ProjectHomepageManager>["files"];
  onAccessChanged: (access: ProjectAccessState) => void;
  onHomepageSaved: () => Promise<void>;
  onHomepageSavingChange: (saving: boolean) => void;
  project: ProjectAccessState & Pick<DemoSummary, "homepage">;
  projectId: string;
}

export function DemoDetailSettings({
  apiUrl,
  csrfToken,
  files,
  onAccessChanged,
  onHomepageSaved,
  onHomepageSavingChange,
  project,
  projectId,
}: DemoDetailSettingsProps) {
  useEffect(() => {
    const hash = window.location.hash;
    if (
      ![
        "#project-homepage",
        "#project-homepage-file",
        "#project-square",
        "#project-settings",
      ].includes(hash)
    )
      return;

    let frame = 0;
    function restoreAnchor() {
      // Let the browser finish its own scroll restoration before positioning an async target.
      frame = requestAnimationFrame(() => {
        const target = document.getElementById(hash.slice(1));
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: "start" });
      });
    }

    if (document.readyState === "complete") restoreAnchor();
    else window.addEventListener("load", restoreAnchor, { once: true });
    return () => {
      window.removeEventListener("load", restoreAnchor);
      cancelAnimationFrame(frame);
    };
  }, [projectId]);

  return (
    <section
      aria-labelledby="project-settings-title"
      className="mb-8 min-w-0 scroll-mt-5"
      id="project-settings"
      tabIndex={-1}
    >
      <h2 className="section-title mb-3" id="project-settings-title">
        项目设置
      </h2>
      <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        <ProjectHomepageManager
          apiUrl={apiUrl}
          projectId={projectId}
          csrfToken={csrfToken}
          homepage={project.homepage}
          files={files}
          onSaved={onHomepageSaved}
          onSavingChange={onHomepageSavingChange}
        />
        <PasswordAccessManager
          access={project}
          apiUrl={apiUrl}
          csrfToken={csrfToken}
          onChanged={onAccessChanged}
          projectId={projectId}
        />
        <ProjectSquareManager key={projectId} apiUrl={apiUrl} projectId={projectId} />
      </div>
    </section>
  );
}
