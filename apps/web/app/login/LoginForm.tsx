"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams?.get("next") ?? "/";

  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Invalid API key");
        setLoading(false);
        return;
      }

      router.push(next);
      router.refresh();
    } catch {
      setError("Unexpected error");
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--pw-space-6)",
        fontFamily: "var(--pw-font-ui)",
        background: "var(--pw-bg)",
        color: "var(--pw-text)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: "100%",
          maxWidth: 360,
          background: "var(--pw-surface)",
          border: "1px solid var(--pw-border)",
          borderRadius: "var(--pw-radius)",
          padding: "var(--pw-space-6)",
        }}
      >
        <h1
          style={{
            fontSize: "var(--pw-space-5)",
            fontWeight: 700,
            marginBottom: "var(--pw-space-2)",
            textAlign: "center",
          }}
        >
          PromptWatch
        </h1>
        <p
          style={{
            color: "var(--pw-text-muted)",
            fontSize: "14px",
            textAlign: "center",
            marginBottom: "var(--pw-space-5)",
          }}
        >
          Enter your API key to continue
        </p>

        {error && (
          <div
            style={{
              color: "var(--pw-danger)",
              background: "rgba(249, 112, 127, 0.1)",
              border: "1px solid rgba(249, 112, 127, 0.3)",
              borderRadius: "var(--pw-radius-sm)",
              padding: "var(--pw-space-3)",
              marginBottom: "var(--pw-space-4)",
              fontSize: "13px",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ marginBottom: "var(--pw-space-4)" }}>
          <label
            htmlFor="apiKey"
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--pw-text-muted)",
              marginBottom: "var(--pw-space-1)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            API Key
          </label>
          <input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="PROMPTWATCH_API_KEY"
            required
            disabled={loading}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "var(--pw-radius-sm)",
              border: "1px solid var(--pw-border)",
              background: "var(--pw-bg)",
              color: "var(--pw-text)",
              fontFamily: "var(--pw-font-mono)",
              fontSize: "14px",
              outline: "none",
            }}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "10px 16px",
            borderRadius: "var(--pw-radius-sm)",
            border: "none",
            background: "var(--pw-primary)",
            color: "#0b1220",
            fontSize: "14px",
            fontWeight: 600,
            fontFamily: "var(--pw-font-ui)",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
            transition: "filter 0.15s ease",
          }}
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}