import { AdminProjectRemoval } from "../../../components/admin-project-removal";

export default function ProjectRemovalPage() {
  return <AdminProjectRemoval apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""} />;
}
