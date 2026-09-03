export interface PublishedDemoFile {
  contentHash: string;
  relativePath: string;
  size: number;
  storageKey: string;
}

export interface ManagedDemoProject {
  createdAt: Date;
  displayName: string;
  fileCount: number;
  projectKey: string;
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
  listOwnedActiveProjects(input: { ownerUserId: string }): Promise<OwnedProjects>;
}

export interface ProjectReader {
  findCurrentFile(input: {
    projectKey: string;
    relativePath: string;
    tenantId: string;
  }): Promise<PublishedDemoFile | null>;
}
