/**
 * Status section — the boundary's inventory read (`GET /api/upstreams`)
 * plus the slim mount probe (`GET /api/status`, ADR-014 D3). The table is
 * one row per configured upstream, in config order: id, type, the probe
 * outcome badge with its failure reason, and the baseUrl (verbatim — it is
 * not secret; credentials ride the rows only as the fixed mask and are not
 * shown). The slim status verdict renders beside the heading. Loads on
 * mount, reloads on the manual refresh button; while loading a spinner, on
 * failure an error alert — a failed probe is data (the badge + reason), not
 * an error.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { fetchStatus, fetchUpstreams, type GatewayStatus, type ManagedUpstream } from "../api.ts";

export function StatusSection(): ReactNode {
  const [upstreams, setUpstreams] = useState<readonly ManagedUpstream[] | null>(null);
  const [verdict, setVerdict] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // Two reads per refresh: the inventory table and the slim probe that
      // carries the gateway's overall verdict (ADR-014 D3).
      const [list, status] = await Promise.all([fetchUpstreams(), fetchStatus()]);
      setUpstreams(list.upstreams);
      setVerdict(status);
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
        <h1 className="h3 mb-0 d-flex align-items-center gap-2" id="status-heading">
          Status
          {verdict !== null && verdict.status !== "" && (
            <span className="badge text-bg-secondary" title="GET /api/status verdict">
              {verdict.status}
            </span>
          )}
        </h1>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw aria-hidden="true" className="me-1 align-text-bottom" size={14} />
          Refresh
        </button>
      </div>
      <p className="text-body-secondary">
        Every configured upstream with its probe outcome, in config order.
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

      {!loading && upstreams !== null && (
        upstreams.length === 0 ? (
          <p className="text-body-secondary">No upstreams configured — add one under Upstreams.</p>
        ) : (
          <table className="table align-middle">
            <thead>
              <tr>
                <th scope="col">id</th>
                <th scope="col">type</th>
                <th scope="col">probe</th>
                <th scope="col">reason</th>
                <th scope="col">baseUrl</th>
              </tr>
            </thead>
            <tbody>
              {upstreams.map((upstream) => (
                <tr key={upstream.id}>
                  <td>
                    <code>{upstream.id}</code>
                  </td>
                  <td>{upstream.type}</td>
                  <td>
                    {upstream.probe === undefined ? (
                      "—"
                    ) : (
                      <span
                        className={`badge ${
                          upstream.probe === "ok" ? "text-bg-success" : "text-bg-danger"
                        }`}
                      >
                        {upstream.probe}
                      </span>
                    )}
                  </td>
                  <td>{upstream.reason ?? "—"}</td>
                  <td>
                    <code>{upstream.baseUrl}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}
