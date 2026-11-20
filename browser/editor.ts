// The edit page's wiring. EasyMDE draws the editor, and Save sends one publish: the markdown, the
// images added since the page opened that the text still names, and every other file marked keep.
// An image is held in the page until then, so an edit abandoned before Save stores nothing.
//
// npm-scripts/build-browser.mjs bundles this to the script the edit page names.

import { CSRF_HEADER, type EditorPlan } from "../src/editor-plan";

interface EasyMde {
  value(): string;
  markdown(text: string): string;
}

interface EasyMdeOptions {
  element: HTMLTextAreaElement;
  spellChecker: boolean;
  autoDownloadFontAwesome: boolean;
  uploadImage: boolean;
  imageAccept: string;
  imageMaxSize: number;
  toolbar: string[];
  previewRender: (text: string) => string;
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

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

interface Pending {
  file: File;
  preview: string;
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
  saveButton: HTMLButtonElement,
  why: HTMLElement,
  plan: EditorPlan,
): void => {
  const pending = new Map<string, Pending>();

  // A relative image resolves into the artifact's own files, as the rendered page resolves it, and
  // an image not yet saved shows from the browser's copy.
  const previewSrc = (src: string): string => {
    const held = pending.get(src);
    if (held !== undefined) return held.preview;
    return ABSOLUTE.test(src) ? src : `${plan.fileBase}/${src}`;
  };

  const publish = async (markdown: string): Promise<string | null> => {
    const added = [...pending].filter(([path]) => markdown.includes(path));
    const body = new FormData();
    const manifest = {
      ...plan.meta,
      files: [
        { path: plan.entry, bytes: new Blob([markdown]).size },
        ...plan.files.filter((path) => path !== plan.entry).map((path) => ({ path, keep: true })),
        ...added.map(([path, held]) => ({ path, bytes: held.file.size })),
      ],
    };
    body.append("manifest", JSON.stringify(manifest));
    body.append(plan.entry, new Blob([markdown], { type: "text/markdown" }), plan.entry);
    for (const [path, held] of added) body.append(path, held.file, path);
    const response = await fetch(plan.publish, { method: "PUT", body, headers: { [CSRF_HEADER]: plan.csrf } });
    return response.ok ? null : refusalOf(response);
  };

  const editor: EasyMde = new EasyMDE({
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
    previewRender: (text) => {
      const template = document.createElement("template");
      template.innerHTML = editor.markdown(text);
      template.content.querySelectorAll("img").forEach((image) => {
        image.src = previewSrc(image.getAttribute("src") ?? "");
      });
      return template.innerHTML;
    },
    imageUploadFunction: (file, onSuccess, onError) => {
      const extension = IMAGE_EXTENSIONS[file.type];
      if (extension === undefined) {
        onError(`${file.name} is not a PNG, JPEG, GIF, WebP or AVIF image.`);
        return;
      }
      const path = `images/${crypto.randomUUID()}.${extension}`;
      pending.set(path, { file, preview: URL.createObjectURL(file) });
      onSuccess(path);
    },
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    why.textContent = "Saving…";
    publish(editor.value()).then(
      (refusal) => {
        if (refusal === null) {
          window.location.assign(plan.base);
          return;
        }
        saveButton.disabled = false;
        why.textContent = refusal;
      },
      (failure: unknown) => {
        saveButton.disabled = false;
        why.textContent = `The save failed: ${String(failure)}`;
      },
    );
  });
};

const form = document.querySelector<HTMLFormElement>("#eform");
const source = document.querySelector<HTMLTextAreaElement>("#esource");
const saveButton = document.querySelector<HTMLButtonElement>("#esave");
const why = document.querySelector<HTMLElement>("#ewhy");
const planSource = document.querySelector<HTMLElement>("#eplan");
if (form === null || source === null || saveButton === null || why === null || planSource === null) {
  throw new Error("the artifact page carries no editor");
}
boot(form, source, saveButton, why, JSON.parse(planSource.textContent ?? "") as EditorPlan);
