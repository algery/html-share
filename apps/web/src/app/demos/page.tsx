import { DemoManager } from "../../components/demo-manager";

export default function DemosPage() {
  return <DemoManager apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""} />;
}
