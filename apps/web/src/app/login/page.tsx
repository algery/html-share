import { OrganizationLogin } from "../../components/organization-login";

interface LoginPageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { status } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-4 py-8 sm:px-6">
      <OrganizationLogin
        apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""}
        status={status}
        clientId={process.env["NEXT_PUBLIC_DINGTALK_CLIENT_ID"]}
        corpId={process.env["NEXT_PUBLIC_DINGTALK_CORP_ID"]}
      />
    </main>
  );
}
