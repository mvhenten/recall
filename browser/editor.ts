// The edit page's wiring. EasyMDE draws the editor; everything this file sends goes through the
// artifact's own publish, with the files that did not change marked keep so only the markdown and
// a new image travel.
//
// npm-scripts/build-browser.mjs bundles this to the script the edit page names.

import { CSRF_HEADER, type EditorPlan } from "../src/editor-plan";

interface EasyMde {
  value(): string;
}

interface EasyMdeOptions {
  element: HTMLTextAreaElement;
  spellChecker: boolean;
  autoDownloadFontAwesome: boolean;
  uploadImage: boolean;
  imageAccept: string;
  imageMaxSize: number;
  toolbar: string[];
  imageUploadFunction: (file: File, onSuccess: (url: string) => void, onError: (message: string) => void) => void;
}

declare const EasyMDE: new (options: EasyMdeOptions) => EasyMde;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

interface Sent {
  path: string;
  body: Blob;
}

const refusalOf = async (response: Response): Promise<string> => {
  const fallback = `The save was refused with status ${response.status}. Reload the page to sign in again, then retry.`;
  const answer: unknown = await response.json().catch(() => null);
  if (typeof answer !== "object" || answer === null || !("error" in answer)) return fallback;
  return typeof answer.error === "string" ? `The save was refused: ${answer.error}.` : fallback;
};

const boot = (
  form: HTMLFormElement,
  source: HTMLTextAreaElement,
  save: HTMLButtonElement,
  why: HTMLElement,
  plan: EditorPlan,
): void => {
  let files = [...plan.files];

  const publish = async (sent: readonly Sent[]): Promise<string | null> => {
    const paths = [...files, ...sent.map((one) => one.path).filter((path) => !files.includes(path))];
    const manifest = {
      ...plan.meta,
      files: paths.map((path) => {
        const one = sent.find((candidate) => candidate.path === path);
        return one === undefined ? { path, keep: true } : { path, bytes: one.body.size };
      }),
    };
    const body = new FormData();
    body.append("manifest", JSON.stringify(manifest));
    for (const path of paths) {
      const one = sent.find((candidate) => candidate.path === path);
      if (one !== undefined) body.append(path, one.body, path);
    }
    const response = await fetch(plan.publish, { method: "PUT", body, headers: { [CSRF_HEADER]: plan.csrf } });
    if (!response.ok) return refusalOf(response);
    files = paths;
    return null;
  };

  const editor = new EasyMDE({
    element: source,
    spellChecker: false,
    autoDownloadFontAwesome: false,
    uploadImage: true,
    imageAccept: Object.keys(IMAGE_EXTENSIONS).join(", "),
    imageMaxSize: MAX_IMAGE_BYTES,
    toolbar: [
      "bold",
      "italic",
      "heading",
      "|",
      "quote",
      "unordered-list",
      "ordered-list",
      "|",
      "link",
      "upload-image",
      "|",
      "preview",
      "side-by-side",
      "fullscreen",
    ],
    imageUploadFunction: (file, onSuccess, onError) => {
      const extension = IMAGE_EXTENSIONS[file.type];
      if (extension === undefined) {
        onError(`${file.name} is not a PNG, JPEG, GIF, WebP or AVIF image.`);
        return;
      }
      const path = `images/${crypto.randomUUID()}.${extension}`;
      publish([{ path, body: file }]).then(
        (refusal) => (refusal === null ? onSuccess(path) : onError(refusal)),
        (failure: unknown) => onError(`The upload failed: ${String(failure)}`),
      );
    },
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save.disabled = true;
    why.textContent = "Saving…";
    const markdown = new Blob([editor.value()], { type: "text/markdown" });
    publish([{ path: plan.entry, body: markdown }]).then(
      (refusal) => {
        if (refusal === null) {
          window.location.assign(plan.base);
          return;
        }
        save.disabled = false;
        why.textContent = refusal;
      },
      (failure: unknown) => {
        save.disabled = false;
        why.textContent = `The save failed: ${String(failure)}`;
      },
    );
  });
};

const form = document.querySelector<HTMLFormElement>("#eform");
const source = document.querySelector<HTMLTextAreaElement>("#esource");
const save = document.querySelector<HTMLButtonElement>("#esave");
const why = document.querySelector<HTMLElement>("#ewhy");
const planSource = document.querySelector<HTMLElement>("#eplan");
if (form === null || source === null || save === null || why === null || planSource === null) {
  throw new Error("the artifact page carries no editor");
}
boot(form, source, save, why, JSON.parse(planSource.textContent ?? "") as EditorPlan);
