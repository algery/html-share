import { SquareBrowser } from "../../components/square-browser";

export default function SquarePage() {
  return <SquareBrowser apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""} />;
}
