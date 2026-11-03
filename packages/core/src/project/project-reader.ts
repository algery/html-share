export interface PublishedDemoFile {
  contentHash: string;
  relativePath: string;
  size: number;
  storageKey: string;
}

export interface ManagedDemoProject {
  accessMode: "organization" | "password";
  createdAt: Date;
  displayName: string;
  fileCount: number;
  projectKey: string;
  homepagePath?: string | null;
  htmlPaths?: string[];
  totalSize: number;
  updatedAt: Date;
}

export interface OwnedProjects {
  projects: ManagedDemoProject[];
  quota: {
    projectCount: number;
    storageBytes: number;
  };
}

export interface ProjectManagementReader {
  setOwnedHomepage?(input: {
    ownerUserId: string;
    projectKey: string;
    relativePath: string | null;
  }): Promise<"updated" | "not_found" | "invalid_file">;
  listOwnedActiveProjects(input: { ownerUserId: string }): Promise<OwnedProjects>;
  findOwnedActiveProject(input: {
    ownerUserId: string;
    projectKey: string;
  }): Promise<(ManagedDemoProject & { files: { relativePath: string; size: number }[] }) | null>;
}

export interface ProjectReader {
  findCurrentFile(input: {
    projectKey: string;
    relativePath: string;
    tenantId: string;
  }): Promise<PublishedDemoFile | null>;
}
