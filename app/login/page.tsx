"use client";

import { useState } from "react";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const supabase = createClientComponentClient();
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setErrorMsg(error.message);
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", backgroundColor: "#f9fafb", padding: "16px" }}>
      <div style={{ width: "100%", maxWidth: "400px", borderRadius: "8px", backgroundColor: "white", padding: "32px", boxShadow: "0 4px 6px rgba(0,0,0,0.1)" }}>
        <h2 style={{ marginBottom: "24px", fontSize: "24px", fontWeight: "bold", textAlign: "center" }}>
          Sign In to LedgerAI
        </h2>

        {errorMsg && (
          <div style={{ marginBottom: "16px", borderRadius: "4px", backgroundColor: "#fef2f2", padding: "12px", fontSize: "14px", color: "#dc2626" }}>
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <label style={{ display: "block", fontSize: "14px", fontWeight: "500", color: "#374151" }}>
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ marginTop: "4px", display: "block", width: "100%", borderRadius: "4px", border: "1px solid #d1d5db", padding: "8px" }}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "14px", fontWeight: "500", color: "#374151" }}>
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ marginTop: "4px", display: "block", width: "100%", borderRadius: "4px", border: "1px solid #d1d5db", padding: "8px" }}
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{ width: "100%", borderRadius: "4px", backgroundColor: "#2563eb", padding: "10px", color: "white", fontWeight: "500", cursor: "pointer" }}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}