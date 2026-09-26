/**
 * The threshold ring: three arcs, one of them a shade lighter, and the point in the middle.
 * Same paths as assets/logo/mark.svg. With `live`, an arc waits faintly outside the ring
 * until it is in `filled`, then settles in; the point appears once `assembled`.
 */
export default function Mark({ live = false, filled = [], assembled = true }: { live?: boolean; filled?: number[]; assembled?: boolean }) {
  const arcs = [
    { nodeId: 1, d: "M55.90 16.52 A34 34 0 0 1 81.95 61.63", shade: 1 },
    { nodeId: 2, d: "M76.04 71.85 A34 34 0 0 1 23.96 71.85", shade: 1 },
    { nodeId: 3, d: "M18.05 61.63 A34 34 0 0 1 44.10 16.52", shade: 0.86 },
  ];
  const state = (nodeId: number) => (!live ? "" : filled.includes(nodeId) ? "arc in" : "arc out");
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label="DAuth" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round">
      {arcs.map((arc) => (
        <path key={arc.nodeId} d={arc.d} className={state(arc.nodeId)} style={{ opacity: arc.shade }} />
      ))}
      <circle cx="50" cy="50" r="7" fill="currentColor" stroke="none" className={!live ? "" : assembled ? "dot in" : "dot out"} />
    </svg>
  );
}
