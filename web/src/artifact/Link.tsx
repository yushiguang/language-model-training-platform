import type {AnchorHTMLAttributes, Ref} from 'react';

/** Stands in for next/link in the single-file build, which has no router. */
export default function Link({ref, ...props}: AnchorHTMLAttributes<HTMLAnchorElement> & {ref?: Ref<HTMLAnchorElement>}) {
  return <a ref={ref} {...props} />;
}
