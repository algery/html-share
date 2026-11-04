// Delete only records owned by this invocation's random tenant, including audit rows without FKs.
export async function cleanupSmokeRows(prisma, tenantId, states) {
  if (tenantId) {
    const [projects, tasks, revisions, users] = await Promise.all(
      [prisma.demoProject, prisma.uploadTask, prisma.revision, prisma.user].map((model) =>
        model.findMany({ where: { tenantId }, select: { id: true } }),
      ),
    );
    const userIds = users.map((row) => row.id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { projectId: { in: projects.map((row) => row.id) } },
          { actorUserId: { in: userIds } },
          { ownerUserId: { in: userIds } },
        ],
      },
    });
    await prisma.cleanupJob.deleteMany({
      where: { targetId: { in: [...projects, ...tasks, ...revisions].map((row) => row.id) } },
    });
    await prisma.demoProject.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }
  await prisma.authState.deleteMany({ where: { stateDigest: { in: states } } });
}
