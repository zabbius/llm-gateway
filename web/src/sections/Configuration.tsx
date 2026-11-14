/**
 * Configuration section — the sanitized effective configuration
 * (`GET /api/configuration`, specs/contracts/gateway-management.md): the
 * `server` (`listen`, `tls`) / `logLevel` summary and the upstream table.
 * Secrets are rendered exactly as the API returns them — `apiKey` is always
 * the fixed mask literal, `tlsFingerprint` the mask or null — the SPA has no
 * way to unmask them and never sees the real values.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fetchConfiguration, type GatewayConfiguration } from "../api.ts";

/** The tls summary line: "TLS: enabled — cert <path>", "TLS: disabled", or "—" when the config carries no tls block. */
function tlsLine(tls: GatewayConfiguration["server"]["tls"]): string {
  if (tls === null) return "—";
  return tls.enabled ? `TLS: enabled — cert ${tls.cert ?? "—"}` : "TLS: disabled";
}

/** The auth summary line: "—" (ungated) or "enabled/disabled · user · passwordHash (mask)". */
function authLine(auth: GatewayConfiguration["auth"]): ReactNode {
  if (auth === null) return "—";
  return (
    <>
      <code>{auth.enabled ? "enabled" : "disabled"}</code>
      {" · user "}
      <code>{auth.user ?? "—"}</code>
      {" · passwordHash "}
      <code>{auth.passwordHash ?? "—"}</code>
    </>
  );
}

export function ConfigurationSection(): ReactNode {
  const [configuration, setConfiguration] = useState<GatewayConfiguration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const body = await fetchConfiguration();
        if (!cancelled) setConfiguration(body);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-labelledby="configuration-heading">
      <h1 className="h3 mb-2" id="configuration-heading">
        Configuration
      </h1>
      <p className="text-body-secondary">
        The effective configuration with credentials masked — exactly what the
        gateway serves on <code>GET /api/configuration</code>.
      </p>

      {error !== null && (
        <div className="alert alert-danger" role="alert">
          Failed to load configuration: {error}
        </div>
      )}

      {loading && (
        <div className="d-flex justify-content-center py-5" role="status">
          <div className="spinner-border" aria-hidden="true"></div>
          <span className="visually-hidden">Loading…</span>
        </div>
      )}

      {configuration !== null && (
        <>
          <dl className="row mb-4">
            <dt className="col-sm-2">listen</dt>
            <dd className="col-sm-10">
              <code>{configuration.server.listen}</code>
            </dd>
            <dt className="col-sm-2">tls</dt>
            <dd className="col-sm-10">{tlsLine(configuration.server.tls)}</dd>
            <dt className="col-sm-2">logLevel</dt>
            <dd className="col-sm-10">
              <code>{configuration.logLevel}</code>
            </dd>
            <dt className="col-sm-2">auth</dt>
            <dd className="col-sm-10">{authLine(configuration.auth)}</dd>
          </dl>

          {configuration.upstreams.length === 0 ? (
            <p className="text-body-secondary">No upstreams configured.</p>
          ) : (
            <table className="table align-middle">
              <thead>
                <tr>
                  <th scope="col">id</th>
                  <th scope="col">type</th>
                  <th scope="col">baseUrl</th>
                  <th scope="col">apiKey</th>
                  <th scope="col">tlsFingerprint</th>
                </tr>
              </thead>
              <tbody>
                {configuration.upstreams.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <code>{entry.id}</code>
                    </td>
                    <td>{entry.type}</td>
                    <td>
                      <code>{entry.baseUrl}</code>
                    </td>
                    <td>
                      <code>{entry.apiKey}</code>
                    </td>
                    <td>
                      <code>{entry.tlsFingerprint ?? "—"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
