export const EDIT_VIEW = "edit";

export const CSRF_HEADER = "x-recall-csrf";

// What the edit page hands its script: where the publish goes, the token it sends back, the
// manifest fields that stay as they are (as the publish parses them, so the browser bundle reads
// none of the Worker's types), the files in the order the revision holds them, and
// the address they answer under, which the preview resolves a relative image against.
export interface EditorPlan {
  base: string;
  publish: string;
  csrf: string;
  entry: string;
  files: string[];
  fileBase: string;
  meta: {
    type: string;
    title: string;
    description: string;
    read: string;
    write: string;
  };
}
