import { TokenManager } from "../../components/token-manager";

export default function TokensPage() {
  return <TokenManager apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""} />;
}
