import { Suspense } from "react";
import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--pw-font-ui)",
            background: "var(--pw-bg)",
            color: "var(--pw-text)",
          }}
        >
          Loading…
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}