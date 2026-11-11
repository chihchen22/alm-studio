import type { HealthInfo } from "@alm/reader";

/** The server's seed report (GET /api/health seed.stale and seed.retired), printed as-is. */
export function StaleBanner(props: { health: HealthInfo | null }) {
  const stale = props.health?.seed.stale ?? [];
  const retired = props.health?.seed.retired ?? [];
  if (!stale.length && !retired.length) return null;
  return (
    <>
      {stale.length > 0 && (
        <div className="banner" role="status">
          <span className="status status-stale">Stale</span>
          <span className="banner-text">
            Seeded document(s) differ from what the seed writes today:{" "}
            {stale.map((s) => `${s.collection}/${s.id}`).join(", ")}. A stale seed is reported, never rewritten.
          </span>
        </div>
      )}
      {retired.length > 0 && (
        <div className="banner" role="status">
          <span className="status status-stale">Retired</span>
          <span className="banner-text">
            The store still holds document(s) the seed no longer writes:{" "}
            {retired.map((r) => `${r.collection}/${r.id}`).join(", ")}. Move them aside with{" "}
            {retired.map((r) => `npm run platform:seed -- --retire ${r.collection}/${r.id}`).join("; ")}.
          </span>
        </div>
      )}
    </>
  );
}
