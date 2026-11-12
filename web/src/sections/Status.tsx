/**
 * Status section — the upstream health snapshot (`GET /api/status`,
 * specs/contracts/gateway-management.md): every configured upstream with its
 * retained startup-probe outcome, in config order. Loads on mount, reloads
 * on the manual refresh button; while loading a spinner, on failure an
 * error alert — a failed probe is data (the badge + reason), not an error.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchStatus, type GatewayStatus } from "../api.ts";

export function StatusSection(): ReactNode {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section aria-labelledby="status-heading">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h1 className="h3 mb-0" id="status-heading">
          Status
        </h1>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => void refresh()}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      <p className="text-body-secondary">
        Startup-probe outcome of every configured upstream, in config order.
      </p>

      {error !== null && (
        <div className="alert alert-danger" role="alert">
          Failed to load status: {error}
        </div>
      )}

      {loading && (
        <div className="d-flex justify-content-center py-5" role="status">
          <div className="spinner-border" aria-hidden="true"></div>
          <span className="visually-hidden">Loading…</span>
        </div>
      )}

      {!loading && status !== null && (
        status.upstreams.length === 0 ? (
          <p className="text-body-secondary">No upstreams configured.</p>
        ) : (
          <table className="table align-middle">
            <thead>
              <tr>
                <th scope="col">id</th>
                <th scope="col">type</th>
                <th scope="col">probe</th>
                <th scope="col">reason</th>
              </tr>
            </thead>
            <tbody>
              {status.upstreams.map((upstream) => (
                <tr key={upstream.id}>
                  <td>
                    <code>{upstream.id}</code>
                  </td>
                  <td>{upstream.type}</td>
                  <td>
                    <span
                      className={`badge ${
                        upstream.probe === "ok" ? "text-bg-success" : "text-bg-danger"
                      }`}
                    >
                      {upstream.probe}
                    </span>
                  </td>
                  <td>{upstream.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}
