import { redirect } from "next/navigation";

// Dashboard 는 이제 메인(홈) 화면이다. 기존 /dashboard 링크는 / 로 보낸다.
export default function DashboardPage() {
  redirect("/");
}
