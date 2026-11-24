import React, { useState } from "react";

export function LoginScreen({ loading, error, onSubmit }) {
  const [username, setUsername] = useState("nthdz");
  const [password, setPassword] = useState("");

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit({ username, password });
  };

  return (
    <main className="login-shell" aria-labelledby="login-title">
      <section className="login-card panel">
        <p className="kicker">DASHBOARD ACCESS</p>
        <h1 id="login-title">Sign in to the control plane</h1>
        <p className="muted">Use the dashboard admin account to unlock overview, bot lifecycle, logs, and system controls.</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Username
            <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} spellCheck="false" />
          </label>
          <label>
            Password
            <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error ? <div className="error" role="alert">{error}</div> : null}
          <button className="login-button" type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
        </form>
        <p className="muted login-hint">Default credentials can be overridden with environment variables on the server.</p>
      </section>
    </main>
  );
}
