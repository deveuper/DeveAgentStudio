import { DIFFS_TAG_NAME } from "@pierre/diffs"

/**
 * Keep the declaration local to the enterprise package so Windows checkouts
 * do not depend on a Unix symlink being preserved by Git.
 */
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      [DIFFS_TAG_NAME]: HTMLAttributes<HTMLElement>
    }
  }
}

export {}
