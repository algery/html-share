import { SquareDetail } from "../../../components/square-detail";

export default async function SquareDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <SquareDetail
      key={projectId}
      apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""}
      projectId={projectId}
    />
  );
}
