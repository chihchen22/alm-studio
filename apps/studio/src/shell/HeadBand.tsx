import type { ReactNode } from "react";

/** The crumb, the title and the meta line. `chip` is the section's readiness chip, shown beside the title. */
export function HeadBand(props: { crumb: string; title: string; meta: ReactNode; chip?: ReactNode }) {
  const title = <h1 className="page-title">{props.title}</h1>;
  return (
    <header className="head-band">
      <p className="head-crumb">{props.crumb}</p>
      {props.chip === undefined || props.chip === null ? title : <div className="head-title-row">{title}{props.chip}</div>}
      {props.meta === null ? null : <p className="head-meta">{props.meta}</p>}
    </header>
  );
}
