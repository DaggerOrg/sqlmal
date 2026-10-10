import type { ReactNode } from "react";

/** A hash link, so routes work both from the Go server and from GitHub Pages. */
export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={`#/${to}`} className={className} {...rest}>{children}</a>;
}
