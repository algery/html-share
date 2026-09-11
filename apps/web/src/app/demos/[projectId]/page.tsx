import { DemoDetail } from "../../../components/demo-detail";

export default async function DemoDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <DemoDetail
      key={projectId}
      apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""}
      projectId={projectId}
    />
  );
}
